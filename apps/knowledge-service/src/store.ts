// KnowledgeStore — deterministic knowledge platform core (Phase 2).
// Flow: Proposal → Validation → Knowledge Event → Knowledge Store.
// The service owns all writes; agents only submit proposals. No LLM, network,
// broker, or training imports. Unknown/invalid input ⇒ no write (fail-closed).
import type {
  EdgeStatus,
  EntityKind,
  KnowledgeEdge,
  KnowledgeEvent,
  KnowledgeLabel,
  KnowledgeNode,
  KnowledgeProposal,
  KnowledgeProposalInput,
  MemoryCategory,
  MemoryRecord,
  ProposalOp,
  ProvenanceInput,
  RelationshipType,
  SourceType
} from '@aurix/contracts';
import { cyrb53hex, stableStringify } from './hash.js';
import type { KnowledgeTables, Row } from './tables.js';
import { containsSecretPayload } from './secrets.js';
import { canPromoteToFact, downgradeForLlm, isAuthoritative } from './policy.js';

export const SCHEMA_VERSION = 'graph-v1';
const KNOWLEDGE_COMPONENT = 'knowledge';

const ENTITY_KINDS: EntityKind[] = [
  'Company', 'Security', 'Instrument', 'Exchange', 'Sector', 'Industry',
  'Commodity', 'Currency', 'EconomicIndicator', 'MacroEvent', 'NewsEvent',
  'FinancialMetric', 'Strategy', 'Model', 'Prediction', 'Trade', 'Order',
  'Portfolio', 'RiskEvent', 'Agent', 'Observation', 'Experiment'
];

const REL_TYPES: RelationshipType[] = [
  'AFFECTS', 'CORRELATED_WITH', 'DEPENDS_ON', 'COMPETES_WITH', 'CAUSED',
  'PREDICTED', 'OBSERVED', 'TRADED', 'GENERATED_SIGNAL', 'SUPPORTED_BY',
  'CONTRADICTED_BY', 'LEARNED_FROM', 'DERIVED_FROM'
];

const SOURCE_TYPES: SourceType[] = [
  'exchange-filing', 'regulator', 'audited-statement', 'press',
  'market-data', 'llm', 'agent', 'human', 'other'
];

export const VALID_LABELS: KnowledgeLabel[] = ['FACT', 'OBSERVATION', 'INFERENCE', 'HYPOTHESIS', 'PREDICTION', 'UNKNOWN'];

export class KnowledgeError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'KnowledgeError';
  }
}

export interface StoreOptions {
  deviceId?: string;
  now?: () => number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export class KnowledgeStore {
  private deviceId: string;
  private clock: () => number;

  constructor(private tables: KnowledgeTables, opts: StoreOptions = {}) {
    this.deviceId = opts.deviceId ?? 'dev-local';
    this.clock = opts.now ?? (() => Date.now());
  }

  // -- lifecycle --------------------------------------------------------

  propose(input: KnowledgeProposalInput): KnowledgeProposal {
    const id = `kp-${cyrb53hex(stableStringify(input))}`;
    const existing = this.tables.get('proposals', id);
    if (existing) return this.rowToProposal(existing);
    const proposal: KnowledgeProposal = {
      ...input,
      assertion: input.assertion,
      id,
      state: 'PROPOSED',
      reasons: [],
      committed_event_id: null,
      created_at: this.clock()
    };
    this.tables.insert('proposals', {
      id: proposal.id,
      assertion: proposal.assertion,
      ops_json: stableStringify(proposal.ops),
      provenance_json: stableStringify(proposal.provenance),
      actor: proposal.actor,
      state: proposal.state,
      reasons_json: '[]',
      committed_event_id: null,
      created_at: proposal.created_at
    });
    return proposal;
  }

  validate(id: string): KnowledgeProposal {
    const row = this.tables.get('proposals', id);
    if (!row) throw new KnowledgeError('UNKNOWN_PROPOSAL', id);
    const current = this.rowToProposal(row);
    if (current.state !== 'PROPOSED') return current; // idempotent re-validate
    this.setProposalState(id, 'VALIDATING', []);
    const reasons: string[] = [];
    let assertion = current.assertion;

    // 1. assertion + ops shape
    if (!VALID_LABELS.includes(assertion)) {
      return this.reject(id, [`bad assertion: ${assertion}`]);
    }
    if (!Array.isArray(current.ops) || current.ops.length === 0) {
      return this.reject(id, ['proposal has no ops']);
    }
    for (const op of current.ops) {
      const err = this.checkOpShape(op);
      if (err) return this.reject(id, [err]);
    }
    // 2. provenance completeness
    const perr = this.checkProvenance(current.provenance, assertion);
    if (perr) return this.reject(id, [perr]);
    // 3. secrets (strong patterns only) — reject, never store
    if (containsSecretPayload(current.ops) || containsSecretPayload(current.provenance) || containsSecretPayload(current.actor)) {
      return this.reject(id, ['SECRET_DETECTED: proposal carries credential-shaped material']);
    }
    // 4. LLM discipline: bare LLM FACT ⇒ INFERENCE (never auto-FACT)
    const downgraded = downgradeForLlm(assertion, current.provenance.source_type);
    if (downgraded !== assertion) {
      reasons.push(`downgraded: bare ${current.provenance.source_type} FACT claim ⇒ INFERENCE`);
      assertion = downgraded;
    }
    // 5. existence / duplicate / endpoint checks against current store
    const createdInProposal = new Set<string>();
    for (const op of current.ops) {
      if (op.op === 'upsert-node') createdInProposal.add(op.node.id);
    }
    for (const op of current.ops) {
      const err = this.checkAgainstStore(op, createdInProposal, assertion);
      if (err) return this.reject(id, [err]);
    }
    // 6. FACT corroboration policy
    if (assertion === 'FACT') {
      const ferr = this.checkFactPolicy(current);
      if (ferr) {
        this.recordFactClaims(current);
        return this.reject(id, [ferr]);
      }
    }
    this.tables.update('proposals', id, { state: 'VALIDATED', assertion, reasons_json: JSON.stringify(reasons) });
    const done = this.rowToProposal(this.tables.get('proposals', id) as Row);
    done.reasons = reasons;
    return done;
  }

  commit(id: string): { event: KnowledgeEvent; knowledgeVersion: number } {
    const row = this.tables.get('proposals', id);
    if (!row) throw new KnowledgeError('UNKNOWN_PROPOSAL', id);
    const proposal = this.rowToProposal(row);
    if (proposal.state === 'COMMITTED' && proposal.committed_event_id) {
      const prior = this.tables.get('knowledge_events', proposal.committed_event_id);
      if (!prior) throw new KnowledgeError('EVENT_LOST', proposal.committed_event_id);
      return { event: this.rowToEvent(prior), knowledgeVersion: this.knowledgeVersion() };
    }
    if (proposal.state !== 'VALIDATED') {
      throw new KnowledgeError('NOT_VALIDATED', `proposal ${id} is ${proposal.state}`);
    }
    const seq = this.knowledgeVersion() + 1;
    const payload = stableStringify({
      proposal_id: proposal.id,
      assertion: proposal.assertion,
      ops: proposal.ops,
      provenance: proposal.provenance,
      actor: proposal.actor
    });
    const eventId = `ke-${seq}-${cyrb53hex(`${seq}|${payload}`)}`;
    const existingEvent = this.tables.get('knowledge_events', eventId);
    if (existingEvent) {
      this.tables.update('proposals', id, { state: 'COMMITTED', committed_event_id: eventId });
      return { event: this.rowToEvent(existingEvent), knowledgeVersion: this.knowledgeVersion() };
    }
    const now = this.clock();
    const primaryRef = this.primaryRef(proposal.ops);
    this.applyOps(proposal.ops, proposal.assertion, proposal.provenance, proposal.actor, eventId, now);
    // provenance row
    this.tables.insert('provenance', {
      id: `prov-${eventId}`,
      entity_ref: primaryRef,
      what: `${proposal.assertion} commit (${proposal.ops.length} ops)`,
      source: proposal.provenance.source,
      source_type: proposal.provenance.source_type,
      source_identifier: proposal.provenance.source_identifier,
      observed_at: proposal.provenance.observed_at,
      ingested_at: now,
      agent: proposal.provenance.agent,
      model: proposal.provenance.model ?? null,
      prompt_version: proposal.provenance.prompt_version ?? null,
      evidence_refs_json: JSON.stringify(proposal.provenance.evidence_refs),
      confidence: proposal.provenance.confidence,
      validation_state: 'VALIDATED'
    });
    const event: KnowledgeEvent = {
      id: eventId,
      event_type: 'knowledge.commit',
      entity_ref: primaryRef,
      payload: JSON.parse(payload) as Record<string, unknown>,
      actor: proposal.actor,
      label_class: proposal.assertion,
      evidence_refs: [...proposal.provenance.evidence_refs],
      prev_version: `kv-${seq - 1}`,
      new_version: `kv-${seq}`,
      device_id: this.deviceId,
      created_at: now
    };
    this.tables.insert('knowledge_events', {
      id: event.id,
      event_type: event.event_type,
      entity_ref: event.entity_ref,
      payload_json: payload,
      actor: event.actor,
      label_class: event.label_class,
      evidence_refs_json: JSON.stringify(event.evidence_refs),
      prev_version: event.prev_version,
      new_version: event.new_version,
      device_id: event.device_id,
      created_at: event.created_at
    });
    this.setKnowledgeVersion(seq);
    this.tables.update('proposals', id, { state: 'COMMITTED', committed_event_id: eventId });
    return { event, knowledgeVersion: seq };
  }

  proposeValidateCommit(input: KnowledgeProposalInput): { event: KnowledgeEvent; knowledgeVersion: number } {
    const p = this.propose(input);
    const v = this.validate(p.id);
    if (v.state !== 'VALIDATED') {
      throw new KnowledgeError('REJECTED', v.reasons.join('; '));
    }
    return this.commit(v.id);
  }

  // -- replay -----------------------------------------------------------

  /** Rebuild state from an ordered event list. Duplicate events are skipped. */
  replay(events: KnowledgeEvent[]): number {
    const ordered = [...events].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    for (const e of ordered) {
      if (this.tables.get('knowledge_events', e.id)) continue; // idempotent
      const payload = e.payload as {
        assertion: KnowledgeLabel;
        ops: ProposalOp[];
        provenance: ProvenanceInput;
        actor: string;
      };
      const seq = this.eventSeq(e);
      this.applyOps(payload.ops, e.label_class, payload.provenance, e.actor, e.id, e.created_at);
      this.tables.insert('provenance', {
        id: `prov-${e.id}`,
        entity_ref: e.entity_ref,
        what: `${e.label_class} commit (replay)`,
        source: payload.provenance.source,
        source_type: payload.provenance.source_type,
        source_identifier: payload.provenance.source_identifier,
        observed_at: payload.provenance.observed_at,
        ingested_at: e.created_at,
        agent: payload.provenance.agent,
        model: payload.provenance.model ?? null,
        prompt_version: payload.provenance.prompt_version ?? null,
        evidence_refs_json: JSON.stringify(payload.provenance.evidence_refs),
        confidence: payload.provenance.confidence,
        validation_state: 'VALIDATED'
      });
      this.tables.insert('knowledge_events', {
        id: e.id,
        event_type: e.event_type,
        entity_ref: e.entity_ref,
        payload_json: stableStringify(e.payload),
        actor: e.actor,
        label_class: e.label_class,
        evidence_refs_json: JSON.stringify(e.evidence_refs),
        prev_version: e.prev_version,
        new_version: e.new_version,
        device_id: e.device_id,
        created_at: e.created_at
      });
      if (seq > this.knowledgeVersion()) this.setKnowledgeVersion(seq);
    }
    return this.knowledgeVersion();
  }

  // -- queries ----------------------------------------------------------

  getEntity(id: string): KnowledgeNode | undefined {
    const r = this.tables.get('nodes', id);
    return r ? this.rowToNode(r) : undefined;
  }

  getEdges(entityId: string, opts: { direction?: 'out' | 'in' | 'both'; type?: RelationshipType; includeExpired?: boolean } = {}): KnowledgeEdge[] {
    const dir = opts.direction ?? 'both';
    return this.tables
      .query('edges', (r) => {
        const hit = dir === 'out' ? r['src'] === entityId : dir === 'in' ? r['dst'] === entityId : r['src'] === entityId || r['dst'] === entityId;
        if (!hit) return false;
        if (opts.type && r['rel'] !== opts.type) return false;
        if (!opts.includeExpired && r['status'] !== 'ACTIVE') return false;
        return true;
      })
      .map((r) => this.rowToEdge(r))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  neighbors(entityId: string, rel?: RelationshipType): string[] {
    const out = new Set<string>();
    for (const e of this.getEdges(entityId, { type: rel })) {
      out.add(e.src === entityId ? e.dst : e.src);
    }
    return [...out].sort();
  }

  supportingEvidence(ref: string): Row[] {
    return this.linkedEvidence(ref, 'SUPPORTED_BY', true);
  }

  contradictingEvidence(ref: string): Row[] {
    return this.linkedEvidence(ref, 'CONTRADICTED_BY', false);
  }

  entityHistory(id: string): Row[] {
    return this.tables
      .query('node_versions', (r) => r['node_id'] === id)
      .sort((a, b) => (a['version'] as number) - (b['version'] as number));
  }

  knowledgeVersion(): number {
    const r = this.tables.get('versions', KNOWLEDGE_COMPONENT);
    return r ? Number(r['version']) : 0;
  }

  eventsAfter(n: number): KnowledgeEvent[] {
    return this.tables
      .query('knowledge_events', (r) => this.eventSeq(this.rowToEvent(r)) > n)
      .map((r) => this.rowToEvent(r))
      .sort((a, b) => this.eventSeq(a) - this.eventSeq(b));
  }

  provenanceChain(ref: string): Row[] {
    const seen = new Set<string>([ref]);
    for (const e of this.getEdges(ref)) {
      seen.add(e.src === ref ? e.dst : e.src);
    }
    return this.tables
      .query('provenance', (r) => seen.has(String(r['entity_ref'])))
      .sort((a, b) => (a['observed_at'] as number) - (b['observed_at'] as number));
  }

  queryMemories(category: MemoryCategory, key?: string): MemoryRecord[] {
    return this.tables
      .query('memories', (r) => r['category'] === category && (key === undefined || r['key'] === key))
      .map((r) => this.rowToMemory(r))
      .sort((a, b) => a.created_at - b.created_at);
  }

  getEmbeddings(documentId: string): Row[] {
    return this.tables
      .query('embeddings', (r) => r['document_id'] === documentId)
      .sort((a, b) => (a['created_at'] as number) - (b['created_at'] as number));
  }

  // -- export snapshots (deterministic order) -------------------------------

  snapshotNodes(): KnowledgeNode[] {
    return this.tables
      .query('nodes', (r) => r['status'] === 'ACTIVE')
      .map((r) => this.rowToNode(r))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  snapshotEdges(): KnowledgeEdge[] {
    return this.tables
      .query('edges', (r) => r['status'] === 'ACTIVE')
      .map((r) => this.rowToEdge(r))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  snapshotProvenance(): Row[] {
    return this.tables
      .query('provenance')
      .sort((a, b) => (String(a['id']) < String(b['id']) ? -1 : 1));
  }

  snapshotMemories(): MemoryRecord[] {
    return this.tables
      .query('memories')
      .map((r) => this.rowToMemory(r))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  snapshotEmbeddings(): Row[] {
    return this.tables
      .query('embeddings')
      .map((r) => ({
        id: String(r['id']),
        document_id: String(r['document_id']),
        model: String(r['model']),
        model_version: String(r['model_version']),
        dim: Number(r['dim']),
        vector: JSON.parse(String(r['vector_json'])) as number[],
        metadata: JSON.parse(String(r['metadata_json'] ?? '{}')) as Record<string, unknown>,
        source: String(r['source'] ?? 'local'),
        knowledge_version: Number(r['knowledge_version'] ?? 0),
        created_at: Number(r['created_at'] ?? 0)
      }))
      .sort((a, b) => (String(a['id']) < String(b['id']) ? -1 : 1));
  }

  /** Canonical snapshot for replay comparison and export. */
  snapshotCanonical(): string {    const nodes = this.tables
      .query('nodes', (r) => r['status'] === 'ACTIVE')
      .map((r) => this.rowToNode(r))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const edges = this.tables
      .query('edges', (r) => r['status'] === 'ACTIVE')
      .map((r) => this.rowToEdge(r))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const memories = this.tables
      .query('memories')
      .map((r) => this.rowToMemory(r))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    return stableStringify({ nodes, edges, memories, knowledge_version: this.knowledgeVersion() });
  }

  // -- internals --------------------------------------------------------

  private linkedEvidence(ref: string, rel: RelationshipType, includeDirect: boolean): Row[] {
    const out: Row[] = [];
    if (includeDirect) {
      out.push(...this.tables.query('provenance', (r) => r['entity_ref'] === ref));
    }
    for (const e of this.getEdges(ref, { type: rel })) {
      const other = e.src === ref ? e.dst : e.src;
      out.push(...this.tables.query('provenance', (r) => r['entity_ref'] === other));
    }
    return out.sort((a, b) => (a['observed_at'] as number) - (b['observed_at'] as number));
  }

  private checkOpShape(op: ProposalOp): string | null {
    if (op.op === 'upsert-node') {
      if (!op.node.id) return 'node missing id';
      if (!ENTITY_KINDS.includes(op.node.kind)) return `bad entity kind: ${op.node.kind}`;
      if (!op.node.label) return 'node missing label';
      if (!isRecord(op.node.data)) return 'node data must be an object';
      return null;
    }
    if (op.op === 'add-edge') {
      if (!op.edge.src || !op.edge.dst) return 'edge missing endpoints';
      if (!REL_TYPES.includes(op.edge.rel)) return `bad relationship: ${op.edge.rel}`;
      if (op.edge.confidence !== undefined && (!num(op.edge.confidence) || op.edge.confidence < 0 || op.edge.confidence > 1)) {
        return 'edge confidence must be 0..1';
      }
      if (op.edge.data !== undefined && !isRecord(op.edge.data)) return 'edge data must be an object';
      return null;
    }
    if (op.op === 'put-memory') {
      const cats: MemoryCategory[] = ['semantic', 'episodic', 'trading-experience', 'strategy', 'agent', 'evidence'];
      if (!cats.includes(op.memory.category)) return `bad memory category: ${op.memory.category}`;
      if (!op.memory.key) return 'memory missing key';
      if (!isRecord(op.memory.content)) return 'memory content must be an object';
      return null;
    }
    if (op.op === 'put-embedding') {
      if (!op.embedding.document_id) return 'embedding missing document_id';
      if (!op.embedding.model || !op.embedding.model_version) return 'embedding missing model/version';
      if (!Array.isArray(op.embedding.vector) || op.embedding.vector.length === 0) return 'embedding vector empty';
      if (!op.embedding.vector.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'embedding vector must be finite numbers';
      return null;
    }
    return 'unknown op';
  }

  private checkProvenance(p: ProvenanceInput, assertion: KnowledgeLabel): string | null {
    if (!p.source) return 'provenance missing source';
    if (!SOURCE_TYPES.includes(p.source_type)) return `bad source_type: ${p.source_type}`;
    if (!p.source_identifier) return 'provenance missing source_identifier';
    if (!num(p.observed_at) || p.observed_at <= 0) return 'provenance missing observed_at';
    if (!p.agent) return 'provenance missing agent';
    if (!Array.isArray(p.evidence_refs)) return 'evidence_refs must be an array';
    if (assertion !== 'UNKNOWN' && p.evidence_refs.length === 0) return 'provenance requires evidence_refs';
    if (!num(p.confidence) || p.confidence < 0 || p.confidence > 1) return 'confidence must be 0..1';
    return null;
  }

  private checkAgainstStore(op: ProposalOp, createdInProposal: Set<string>, assertion: KnowledgeLabel): string | null {
    if (op.op === 'upsert-node') {
      const cur = this.tables.get('nodes', op.node.id);
      if (cur) {
        const same =
          cur['kind'] === op.node.kind &&
          cur['label'] === op.node.label &&
          stableStringify(cur['data_json'] ? JSON.parse(String(cur['data_json'])) : cur['data']) === stableStringify(op.node.data);
        // Identical FACT re-assertion defers to the corroboration policy
        // (it is evidence, not a duplicate); all other duplicates reject.
        if (same) return assertion === 'FACT' ? null : `DUPLICATE_ENTITY: ${op.node.id} unchanged (use existing version)`;
      }
      return null;
    }
    if (op.op === 'add-edge') {
      const known = (id: string) => !!this.tables.get('nodes', id) || createdInProposal.has(id);
      if (!known(op.edge.src)) return `UNKNOWN_ENDPOINT: ${op.edge.src}`;
      if (!known(op.edge.dst)) return `UNKNOWN_ENDPOINT: ${op.edge.dst}`;
      const dup = this.tables.query('edges', (r) =>
        r['status'] === 'ACTIVE' &&
        r['src'] === op.edge.src && r['dst'] === op.edge.dst && r['rel'] === op.edge.rel &&
        stableStringify(r['data_json'] ? JSON.parse(String(r['data_json'])) : r['data']) === stableStringify(op.edge.data ?? {}) &&
        Number(r['confidence'] ?? 0.5) === (op.edge.confidence ?? 0.5)
      );
      if (dup.length > 0) return `DUPLICATE_EDGE: ${op.edge.src} ${op.edge.rel} ${op.edge.dst} unchanged`;
      return null;
    }
    if (op.op === 'put-memory') {
      const dup = this.tables.query('memories', (r) =>
        r['category'] === op.memory.category && r['key'] === op.memory.key &&
        stableStringify(r['content_json'] ? JSON.parse(String(r['content_json'])) : r['content']) === stableStringify(op.memory.content)
      );
      if (dup.length > 0) return `DUPLICATE_MEMORY: ${op.memory.category}/${op.memory.key} unchanged`;
      return null;
    }
    const dup = this.tables.query('embeddings', (r) =>
      r['document_id'] === op.embedding.document_id && r['model'] === op.embedding.model &&
      r['model_version'] === op.embedding.model_version &&
      stableStringify(r['vector_json'] ? JSON.parse(String(r['vector_json'])) : r['vector']) === stableStringify(op.embedding.vector)
    );
    if (dup.length > 0) return `DUPLICATE_EMBEDDING: ${op.embedding.document_id} @ ${op.embedding.model}`;
    return null;
  }

  private checkFactPolicy(proposal: KnowledgeProposal): string | null {
    const nodeOps = proposal.ops.filter((o): o is Extract<ProposalOp, { op: 'upsert-node' }> => o.op === 'upsert-node');
    if (isAuthoritative(proposal.provenance.source_type)) return null;
    if (nodeOps.length === 0) return 'FACT requires entity anchor or authoritative source (Phase 2)';
    for (const op of nodeOps) {
      const key = `${op.node.id}:${cyrb53hex(stableStringify({ kind: op.node.kind, label: op.node.label, data: op.node.data }))}`;
      const claim = this.tables.get('fact_claims', key);
      const others = claim ? (JSON.parse(String(claim['sources_json'])) as string[]).filter((s) => s !== proposal.provenance.source_identifier) : [];
      if (!canPromoteToFact(proposal.provenance.source_type, others.length + 1)) {
        return `NEEDS_CORROBORATION: ${op.node.id} has ${others.length + 1} independent source(s), need ${2}`;
      }
    }
    return null;
  }

  private recordFactClaims(proposal: KnowledgeProposal): void {
    for (const op of proposal.ops) {
      if (op.op !== 'upsert-node') continue;
      const key = `${op.node.id}:${cyrb53hex(stableStringify({ kind: op.node.kind, label: op.node.label, data: op.node.data }))}`;
      const existing = this.tables.get('fact_claims', key);
      if (existing) {
        const sources = JSON.parse(String(existing['sources_json'])) as string[];
        if (!sources.includes(proposal.provenance.source_identifier)) {
          sources.push(proposal.provenance.source_identifier);
          this.tables.update('fact_claims', key, { sources_json: JSON.stringify(sources) });
        }
      } else {
        this.tables.insert('fact_claims', {
          claim_key: key,
          entity_ref: op.node.id,
          content_hash: cyrb53hex(stableStringify(op.node.data)),
          sources_json: JSON.stringify([proposal.provenance.source_identifier]),
          created_at: this.clock()
        });
      }
    }
  }

  private applyOps(ops: ProposalOp[], assertion: KnowledgeLabel, _prov: ProvenanceInput, actor: string, eventId: string, now: number): void {
    void _prov;
    for (const op of ops) {
      if (op.op === 'upsert-node') {
        const cur = this.tables.get('nodes', op.node.id);
        // Identical re-assertion (e.g. FACT corroboration) records the event
        // without forking a redundant entity version.
        if (cur &&
          cur['kind'] === op.node.kind &&
          cur['label'] === op.node.label &&
          stableStringify(JSON.parse(String(cur['data_json']))) === stableStringify(op.node.data)) {
          continue;
        }
        const version = cur ? Number(cur['version']) + 1 : 1;
        const row = {
          id: op.node.id,
          kind: op.node.kind,
          label: op.node.label,
          data_json: stableStringify(op.node.data),
          label_class: assertion,
          version,
          status: 'ACTIVE',
          created_by: actor,
          created_at: now,
          event_id: eventId
        };
        if (cur) this.tables.update('nodes', op.node.id, row);
        else this.tables.insert('nodes', row);
        this.tables.insert('node_versions', {
          id: `${op.node.id}#v${version}`,
          node_id: op.node.id,
          version,
          data_json: stableStringify(op.node.data),
          label: op.node.label,
          label_class: assertion,
          event_id: eventId,
          created_at: now
        });
      } else if (op.op === 'add-edge') {
        const prior = this.tables.query('edges', (r) =>
          r['status'] === 'ACTIVE' && r['src'] === op.edge.src && r['dst'] === op.edge.dst && r['rel'] === op.edge.rel
        );
        let version = 1;
        for (const p of prior) {
          version = Math.max(version, Number(p['version']) + 1);
          this.tables.update('edges', String(p['id']), { status: 'EXPIRED' as EdgeStatus, valid_until: now });
        }
        const triple = `${op.edge.src}|${op.edge.dst}|${op.edge.rel}`;
        this.tables.insert('edges', {
          id: `e-${cyrb53hex(triple)}-v${version}`,
          src: op.edge.src,
          dst: op.edge.dst,
          rel: op.edge.rel,
          data_json: stableStringify(op.edge.data ?? {}),
          label_class: assertion,
          confidence: op.edge.confidence ?? 0.5,
          provenance_ref: `prov-${eventId}`,
          version,
          status: 'ACTIVE' as EdgeStatus,
          valid_from: op.edge.valid_from ?? now,
          valid_until: op.edge.valid_until ?? null,
          created_by: actor,
          created_at: now,
          event_id: eventId
        });
      } else if (op.op === 'put-memory') {
        this.tables.insert('memories', {
          id: `mem-${cyrb53hex(`${op.memory.category}|${op.memory.key}|${stableStringify(op.memory.content)}`)}`,
          category: op.memory.category,
          key: op.memory.key,
          content_json: stableStringify(op.memory.content),
          embedding_ref: op.memory.embedding_ref ?? null,
          regime: op.memory.regime ?? null,
          strategy_id: op.memory.strategy_id ?? null,
          label_class: assertion,
          event_id: eventId,
          created_at: now
        });
      } else {
        this.tables.insert('embeddings', {
          id: `emb-${cyrb53hex(`${op.embedding.document_id}|${op.embedding.model}|${op.embedding.model_version}|${stableStringify(op.embedding.vector)}`)}`,
          document_id: op.embedding.document_id,
          model: op.embedding.model,
          model_version: op.embedding.model_version,
          dim: op.embedding.vector.length,
          vector_json: stableStringify(op.embedding.vector),
          metadata_json: stableStringify(op.embedding.metadata ?? {}),
          source: op.embedding.source ?? 'local',
          knowledge_version: this.knowledgeVersion() + 1,
          created_at: now
        });
      }
    }
  }

  private primaryRef(ops: ProposalOp[]): string {
    for (const op of ops) {
      if (op.op === 'upsert-node') return op.node.id;
      if (op.op === 'add-edge') return op.edge.src;
      if (op.op === 'put-memory') return `${op.memory.category}:${op.memory.key}`;
    }
    const last = ops[ops.length - 1];
    if (last && last.op === 'put-embedding') return last.embedding.document_id;
    return 'unknown';
  }

  private setProposalState(id: string, state: KnowledgeProposal['state'], reasons: string[]): void {
    this.tables.update('proposals', id, { state, reasons_json: JSON.stringify(reasons) });
  }

  private reject(id: string, reasons: string[]): KnowledgeProposal {
    this.setProposalState(id, 'REJECTED', reasons);
    const done = this.rowToProposal(this.tables.get('proposals', id) as Row);
    done.reasons = reasons;
    return done;
  }

  private setKnowledgeVersion(seq: number): void {
    const cur = this.tables.get('versions', KNOWLEDGE_COMPONENT);
    if (cur) this.tables.update('versions', KNOWLEDGE_COMPONENT, { version: seq, checksum: '', created_at: this.clock() });
    else this.tables.insert('versions', { component: KNOWLEDGE_COMPONENT, version: seq, checksum: '', created_at: this.clock() });
  }

  private eventSeq(e: KnowledgeEvent): number {
    const m = /^kv-(\d+)$/.exec(e.new_version);
    return m ? Number(m[1]) : 0;
  }

  // -- row codecs (table rows carry both DDL columns and logical fields) ---

  private rowToProposal(r: Row): KnowledgeProposal {
    return {
      id: String(r['id']),
      assertion: r['assertion'] as KnowledgeLabel,
      ops: JSON.parse(String(r['ops_json'])) as ProposalOp[],
      provenance: JSON.parse(String(r['provenance_json'])) as ProvenanceInput,
      actor: String(r['actor']),
      state: r['state'] as KnowledgeProposal['state'],
      reasons: JSON.parse(String(r['reasons_json'] ?? '[]')) as string[],
      committed_event_id: (r['committed_event_id'] as string | null) ?? null,
      created_at: Number(r['created_at'])
    };
  }

  private rowToNode(r: Row): KnowledgeNode {
    return {
      id: String(r['id']),
      kind: r['kind'] as EntityKind,
      label: String(r['label']),
      data: r['data_json'] ? (JSON.parse(String(r['data_json'])) as Record<string, unknown>) : ((r['data'] ?? {}) as Record<string, unknown>),
      label_class: r['label_class'] as KnowledgeLabel,
      version: Number(r['version'] ?? 1),
      status: (r['status'] as KnowledgeNode['status']) ?? 'ACTIVE',
      created_by: String(r['created_by'] ?? ''),
      created_at: Number(r['created_at'] ?? 0),
      event_id: String(r['event_id'] ?? '')
    };
  }

  private rowToEdge(r: Row): KnowledgeEdge {
    return {
      id: String(r['id']),
      src: String(r['src']),
      dst: String(r['dst']),
      rel: r['rel'] as RelationshipType,
      data: r['data_json'] ? (JSON.parse(String(r['data_json'])) as Record<string, unknown>) : ((r['data'] ?? {}) as Record<string, unknown>),
      label_class: r['label_class'] as KnowledgeLabel,
      confidence: Number(r['confidence'] ?? 0.5),
      provenance_ref: String(r['provenance_ref'] ?? ''),
      version: Number(r['version'] ?? 1),
      status: (r['status'] as KnowledgeEdge['status']) ?? 'ACTIVE',
      valid_from: Number(r['valid_from'] ?? r['created_at'] ?? 0),
      valid_until: r['valid_until'] == null ? null : Number(r['valid_until']),
      created_by: String(r['created_by'] ?? ''),
      created_at: Number(r['created_at'] ?? 0),
      event_id: String(r['event_id'] ?? '')
    };
  }

  private rowToEvent(r: Row): KnowledgeEvent {
    return {
      id: String(r['id']),
      event_type: String(r['event_type']),
      entity_ref: String(r['entity_ref']),
      payload: JSON.parse(String(r['payload_json'])) as Record<string, unknown>,
      actor: String(r['actor']),
      label_class: r['label_class'] as KnowledgeLabel,
      evidence_refs: JSON.parse(String(r['evidence_refs_json'] ?? '[]')) as string[],
      prev_version: String(r['prev_version']),
      new_version: String(r['new_version']),
      device_id: String(r['device_id'] ?? ''),
      created_at: Number(r['created_at'])
    };
  }

  private rowToMemory(r: Row): MemoryRecord {
    return {
      id: String(r['id']),
      category: r['category'] as MemoryCategory,
      key: String(r['key']),
      content: r['content_json'] ? (JSON.parse(String(r['content_json'])) as Record<string, unknown>) : ((r['content'] ?? {}) as Record<string, unknown>),
      embedding_ref: (r['embedding_ref'] as string | null) ?? null,
      regime: (r['regime'] as string | null) ?? null,
      strategy_id: (r['strategy_id'] as string | null) ?? null,
      label_class: (r['label_class'] as KnowledgeLabel) ?? 'OBSERVATION',
      event_id: String(r['event_id'] ?? ''),
      created_at: Number(r['created_at'] ?? 0)
    };
  }
}
