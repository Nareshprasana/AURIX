// MemoryManager — deterministic memory-aware layer over KnowledgeStore.
// Memory ≠ truth ≠ current state ≠ permission to skip verification. Freshness,
// confidence, validation and truth stay separate; relevance scores are explicitly
// heuristic. The LLM may explain decisions; it cannot override evidence.
import type {
  KnowledgeLabel,
  KnowledgeNode,
  MemoryCategory,
  MemoryRecord
} from '@aurix/contracts';
import {
  KnowledgeStore,
  cyrb53hex,
  stableStringify
} from '@aurix/knowledge-service';
import type {
  CanonicalBar,
  CanonicalQuote,
  MarketEvent,
  MarketRecord,
  QualityReport
} from '@aurix/market-data';
import { invalidationTopicsFor, recordId } from '@aurix/market-data';
import { redact } from '@aurix/observability';
import { MEMORY_FRESHNESS, classifyMemoryAge, jaccardSimilarity, normalizeTaskKey } from './freshness.js';
import type { MemoryDomain, MemoryFreshness } from './freshness.js';

export type ReuseDecisionValue = 'REUSE' | 'REFRESH' | 'RESEARCH' | 'CONFLICT' | 'INSUFFICIENT';
export type GapStatus = 'KNOWN' | 'UNKNOWN' | 'STALE' | 'CONFLICTED' | 'MISSING';
export type MarkerStatus = 'STALE' | 'SUPERSEDED' | 'CONTRADICTED' | 'INVALIDATED';
export type TaskStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SUPERSEDED';

export interface RetrievalFilter {
  entity?: string;
  topic?: string;
  strategy?: string;
  agent?: string;
  event?: string;
  memoryType?: MemoryCategory | 'node';
  fromTs?: number;
  toTs?: number;
  labels?: KnowledgeLabel[];
  minConfidence?: number;
  requester?: string;
  limit?: number;
}

export interface RetrievalHit {
  kind: 'node' | 'memory';
  id: string;
  entity: string;
  topic: string;
  domain: MemoryDomain;
  created_at: number;
  last_verified_at: number;
  confidence: number | null;
  label: KnowledgeLabel;
  validation: 'validated' | 'observed' | 'unvalidated';
  relevance: { score: number; heuristic: true; matched_on: string[] };
  record: unknown;
}

export interface ReuseRequest {
  subject: string;
  topic?: string;
  agent?: string;
  minConfidence?: number;
  evidenceThreshold?: number;
  now?: number;
}

export interface ReuseDecision {
  decision: ReuseDecisionValue;
  basis: string[];
  candidates: RetrievalHit[];
}

export interface TopicRule {
  topic: string;
  entity_ids: string[];
  memory_keys: string[];
}

export interface ResearchTaskRecord {
  task_id: string;
  subject: string;
  objective: string;
  scope: string;
  task_key: string;
  requested_at: number;
  agent: string;
  status: TaskStatus;
  result_reference: string | null;
  knowledge_version: number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export class MemoryManager {
  constructor(private knowledge: KnowledgeStore) {}

  // -- retrieval --------------------------------------------------------------

  retrieve(filter: RetrievalFilter = {}, now = Date.now()): RetrievalHit[] {
    const hits: RetrievalHit[] = [];
    const wantNode = !filter.memoryType || filter.memoryType === 'node';
    if (wantNode) {
      for (const n of this.knowledge.snapshotNodes()) {
        const hit = this.nodeHit(n, filter, now);
        if (hit) hits.push(hit);
      }
    }
    if (!filter.memoryType || filter.memoryType !== 'node') {
      for (const m of this.knowledge.snapshotMemories()) {
        if (filter.memoryType && m.category !== filter.memoryType) continue;
        const hit = this.memoryHit(m, filter, now);
        if (hit) hits.push(hit);
      }
    }
    hits.sort((a, b) => b.relevance.score - a.relevance.score || (a.created_at - b.created_at));
    return filter.limit !== undefined ? hits.slice(0, filter.limit) : hits;
  }

  private baseRelevance(opts: { entityMatch: boolean; topicMatch: boolean; freshness: MemoryFreshness; validation: RetrievalHit['validation']; confidence: number | null }): RetrievalHit['relevance'] {
    const matched_on: string[] = [];
    let score = 0;
    if (opts.entityMatch) { score += 0.5; matched_on.push('entity'); }
    if (opts.topicMatch) { score += 0.2; matched_on.push('topic'); }
    const freshW = opts.freshness === 'FRESH' ? 0.15 : opts.freshness === 'AGING' ? 0.1 : opts.freshness === 'UNKNOWN' ? 0.05 : 0.02;
    score += freshW;
    matched_on.push(`freshness:${opts.freshness}`);
    const valW = opts.validation === 'validated' ? 0.1 : opts.validation === 'observed' ? 0.07 : 0.03;
    score += valW;
    matched_on.push(`validation:${opts.validation}`);
    if (opts.confidence !== null) {
      score += opts.confidence * 0.05;
      matched_on.push('confidence');
    }
    return { score: Math.min(1, score), heuristic: true, matched_on };
  }

  private passCommon(createdAt: number, confidence: number | null, label: KnowledgeLabel, filter: RetrievalFilter): boolean {
    if (filter.fromTs !== undefined && createdAt < filter.fromTs) return false;
    if (filter.toTs !== undefined && createdAt > filter.toTs) return false;
    if (filter.labels && !filter.labels.includes(label)) return false;
    if (filter.minConfidence !== undefined && (confidence === null || confidence < filter.minConfidence)) return false;
    return true;
  }

  private nodeHit(n: KnowledgeNode, filter: RetrievalFilter, now: number): RetrievalHit | null {
    const data = asRecord(n.data);
    const entity = n.id;
    const entityMatch = filter.entity === undefined || entity === filter.entity || data['entity'] === filter.entity;
    const topic = str(data['topic']) ?? 'general';
    const topicMatch = filter.topic === undefined || topic === filter.topic;
    if (!entityMatch || !topicMatch) return null;
    if (filter.strategy !== undefined && data['strategy'] !== filter.strategy) return null;
    if (filter.event !== undefined && data['event'] !== filter.event) return null;
    if (filter.agent !== undefined) return null; // nodes are not agent-scoped
    if (!this.passCommon(n.created_at, null, n.label_class, filter)) return null;
    const domain = (str(data['domain']) ?? 'default') as MemoryDomain;
    const freshness = classifyMemoryAge(domain, now - n.created_at);
    const validation = n.label_class === 'FACT' ? 'validated' : n.label_class === 'OBSERVATION' ? 'observed' : 'unvalidated';
    return {
      kind: 'node', id: n.id, entity, topic, domain,
      created_at: n.created_at, last_verified_at: n.created_at, confidence: null,
      label: n.label_class, validation,
      relevance: this.baseRelevance({ entityMatch: filter.entity !== undefined && entityMatch, topicMatch: filter.topic !== undefined && topicMatch, freshness, validation, confidence: null }),
      record: { id: n.id, kind: n.kind, label: n.label, data: n.data, version: n.version }
    };
  }

  private memoryHit(m: MemoryRecord, filter: RetrievalFilter, now: number): RetrievalHit | null {
    const content = asRecord(m.content);
    // Owner ACL: agent memories visible to owner or orchestrator only.
    if (m.category === 'agent') {
      const owner = str(content['agent']);
      if (filter.requester !== 'orchestrator' && owner !== filter.requester) return null;
    }
    const entity = str(content['entity']) ?? m.key;
    const entityMatch = filter.entity === undefined || entity === filter.entity || m.key === filter.entity || m.key.endsWith(`:${filter.entity}`);
    const topic = str(content['topic']) ?? 'general';
    const topicMatch = filter.topic === undefined || topic === filter.topic;
    if (!entityMatch || !topicMatch) return null;
    if (filter.strategy !== undefined && (m.strategy_id !== filter.strategy && content['strategy'] !== filter.strategy)) return null;
    if (filter.agent !== undefined && content['agent'] !== filter.agent) return null;
    if (filter.event !== undefined && content['event'] !== filter.event) return null;
    const confidence = typeof content['confidence'] === 'number' ? content['confidence'] : null;
    if (!this.passCommon(m.created_at, confidence, m.label_class, filter)) return null;
    const domain = (str(content['domain']) ?? 'default') as MemoryDomain;
    const verifiedAt = typeof content['verified_at'] === 'number' ? content['verified_at'] : m.created_at;
    const freshness = classifyMemoryAge(domain, now - verifiedAt);
    const validation = m.label_class === 'FACT' ? 'validated' : m.label_class === 'OBSERVATION' ? 'observed' : 'unvalidated';
    return {
      kind: 'memory', id: m.id, entity, topic, domain,
      created_at: m.created_at, last_verified_at: verifiedAt, confidence,
      label: m.label_class, validation,
      relevance: this.baseRelevance({ entityMatch: filter.entity !== undefined && entityMatch, topicMatch: filter.topic !== undefined && topicMatch, freshness, validation, confidence }),
      record: { id: m.id, category: m.category, key: m.key, content: m.content }
    };
  }

  freshnessOf(hit: Pick<RetrievalHit, 'domain' | 'created_at' | 'last_verified_at'>, now: number): MemoryFreshness {
    return classifyMemoryAge(hit.domain, now - hit.last_verified_at);
  }

  // -- reuse decision (deterministic; LLM cannot override evidence) ------------

  decide(request: ReuseRequest): ReuseDecision {
    const now = request.now ?? Date.now();
    const minConfidence = request.minConfidence ?? 0.5;
    const evidenceThreshold = request.evidenceThreshold ?? 1;
    const candidates = this.retrieve({ entity: request.subject, topic: request.topic, requester: request.agent }, now);
    if (candidates.length === 0) {
      return { decision: 'RESEARCH', basis: [`no candidates for ${request.subject}`], candidates };
    }
    // Contradiction: same subject+topic, distinct validated-looking content.
    const byTopic = new Map<string, RetrievalHit[]>();
    for (const c of candidates) {
      if (c.validation === 'validated' || c.validation === 'observed') {
        const list = byTopic.get(c.topic) ?? [];
        list.push(c);
        byTopic.set(c.topic, list);
      }
    }
    for (const [topic, list] of byTopic) {
      const contents = new Set(list.map((c) => stableStringify((c.record as { data?: unknown; content?: unknown }).data ?? (c.record as { content?: unknown }).content)));
      if (contents.size > 1) {
        return { decision: 'CONFLICT', basis: [`${contents.size} contradictory validated-looking records on topic ${topic}`], candidates };
      }
    }
    const markers = this.markersFor(request.subject, request.topic ? `${request.topic}:${request.subject}` : undefined);
    if (markers.some((m) => (m.content as { status?: string }).status === 'CONTRADICTED') ||
        markers.some((m) => (m.content as { status?: string }).status === 'INVALIDATED')) {
      return { decision: 'CONFLICT', basis: ['invalidation marker records contradiction'], candidates };
    }
    const confident = candidates.filter((c) => (c.confidence ?? 0) >= minConfidence);
    if (confident.length < evidenceThreshold) {
      return { decision: 'INSUFFICIENT', basis: [`${confident.length}/${candidates.length} meet confidence ${minConfidence} (need ${evidenceThreshold})`], candidates };
    }
    const best = [...candidates].sort((a, b) => b.relevance.score - a.relevance.score)[0]!;
    const fresh = this.freshnessOf(best, now);
    const staleMarked = markers.some((m) => ['STALE', 'SUPERSEDED', 'INVALIDATED'].includes((m.content as { status?: string }).status ?? ''));
    if (fresh === 'STALE' || staleMarked) {
      return { decision: 'REFRESH', basis: [`best candidate ${best.id} is ${fresh}${staleMarked ? ' + marked stale' : ''}`], candidates };
    }
    return { decision: 'REUSE', basis: [`${best.id} ${fresh}, ${best.validation}, confidence ${best.confidence ?? 'unknown'}`], candidates };
  }

  // -- research tasks -----------------------------------------------------------

  registerTask(input: { subject: string; objective: string; scope: string; agent: string; actor: string; now?: number }): { task: ResearchTaskRecord; deduplicated: boolean } {
    const now = input.now ?? Date.now();
    const key = normalizeTaskKey(input.subject, input.objective, input.scope);
    const existing = this.findTasks({ subject: input.subject }).find((t) => t.task_key === key);
    if (existing && (existing.status === 'COMPLETED' || existing.status === 'RUNNING' || existing.status === 'PENDING')) {
      const age = now - existing.requested_at;
      const fresh = classifyMemoryAge('research', age);
      if (existing.status !== 'COMPLETED' || fresh === 'FRESH') {
        return { task: existing, deduplicated: true };
      }
    }
    const id = `task-${cyrb53hex(key).slice(0, 12)}-kv${this.knowledge.knowledgeVersion()}`;
    const task: ResearchTaskRecord = {
      task_id: id, subject: input.subject, objective: input.objective, scope: input.scope,
      task_key: key, requested_at: now, agent: input.agent, status: 'PENDING',
      result_reference: null, knowledge_version: this.knowledge.knowledgeVersion()
    };
    this.knowledge.proposeValidateCommit({
      assertion: 'OBSERVATION',
      ops: [{ op: 'upsert-node', node: { id, kind: 'Experiment', label: input.objective, data: { ...task } } }],
      provenance: { source: 'research-registry', source_type: 'agent', source_identifier: `task-registry:${input.agent}`, observed_at: now, agent: input.agent, evidence_refs: [`task-key:${key}`], confidence: 1 },
      actor: input.actor
    });
    return { task, deduplicated: false };
  }

  completeTask(taskId: string, resultReference: string, status: TaskStatus, actor: string, now = Date.now()): ResearchTaskRecord {
    const node = this.knowledge.getEntity(taskId);
    if (!node || node.kind !== 'Experiment') throw new Error(`UNKNOWN_TASK: ${taskId}`);
    const data = { ...(node.data as object), status, result_reference: resultReference, knowledge_version: this.knowledge.knowledgeVersion() } as Record<string, unknown>;
    this.knowledge.proposeValidateCommit({
      assertion: 'OBSERVATION',
      ops: [{ op: 'upsert-node', node: { id: taskId, kind: 'Experiment', label: node.label, data } }],
      provenance: { source: 'research-registry', source_type: 'agent', source_identifier: `task-registry:${actor}`, observed_at: now, agent: actor, evidence_refs: [taskId], confidence: 1 },
      actor
    });
    return this.readTask(this.knowledge.getEntity(taskId)!);
  }

  findTasks(filter: { subject?: string; status?: TaskStatus } = {}): ResearchTaskRecord[] {
    return this.knowledge.snapshotNodes()
      .filter((n) => n.kind === 'Experiment' && (n.id.startsWith('task-') || (n.data as { task_key?: string }).task_key !== undefined))
      .map((n) => this.readTask(n))
      .filter((t) => (!filter.subject || t.subject === filter.subject) && (!filter.status || t.status === filter.status))
      .sort((a, b) => a.requested_at - b.requested_at);
  }

  private readTask(n: { id: string; data: unknown }): ResearchTaskRecord {
    const d = asRecord(n.data);
    return {
      task_id: String(d['task_id'] ?? n.id),
      subject: String(d['subject'] ?? ''),
      objective: String(d['objective'] ?? ''),
      scope: String(d['scope'] ?? ''),
      task_key: String(d['task_key'] ?? ''),
      requested_at: Number(d['requested_at'] ?? 0),
      agent: String(d['agent'] ?? ''),
      status: (d['status'] ?? 'PENDING') as TaskStatus,
      result_reference: (d['result_reference'] as string | null) ?? null,
      knowledge_version: Number(d['knowledge_version'] ?? 0)
    };
  }

  findSimilar(input: { subject: string; objective: string; scope: string }, threshold = 0.5): { task: ResearchTaskRecord; similarity: number }[] {
    const probe = `${input.subject} ${input.objective} ${input.scope}`;
    return this.findTasks()
      .map((task) => ({ task, similarity: jaccardSimilarity(probe, `${task.subject} ${task.objective} ${task.scope}`) }))
      .filter((r) => r.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity);
  }

  // -- invalidation (mark, never delete) ------------------------------------------

  invalidate(input: { targets: string[]; cause: string; eventRef: string; actor: string; status?: MarkerStatus; now?: number }): string[] {
    const now = input.now ?? Date.now();
    const status = input.status ?? 'STALE';
    const ids: string[] = [];
    for (const target of input.targets) {
      const { event } = this.knowledge.proposeValidateCommit({
        assertion: 'OBSERVATION',
        ops: [{ op: 'put-memory', memory: { category: 'evidence', key: `invalidation:${target}`, content: { target, status, cause: input.cause, event_ref: input.eventRef, at: now, domain: 'default' } } }],
        provenance: { source: 'memory-manager', source_type: 'agent', source_identifier: `invalidation:${input.actor}`, observed_at: now, agent: input.actor, evidence_refs: [input.eventRef, target], confidence: 1 },
        actor: input.actor
      });
      void event;
      ids.push(`invalidation:${target}`);
    }
    return ids;
  }

  markersFor(target: string, qualified?: string): { content: unknown; created_at: number }[] {
    const keys = qualified ? [`invalidation:${target}`, `invalidation:${qualified}`] : [`invalidation:${target}`];
    return this.knowledge.snapshotMemories()
      .filter((m) => m.category === 'evidence' && keys.includes(m.key))
      .map((m) => ({ content: m.content, created_at: m.created_at }))
      .sort((a, b) => a.created_at - b.created_at);
  }

  // -- gaps + budget ---------------------------------------------------------------

  gapReport(subject: string, rules: TopicRule[], now = Date.now(), requester?: string): { topic: string; status: GapStatus; counts: { fresh: number; stale: number; unknown: number; total: number } }[] {
    return rules.map((rule) => {
      const hits = this.retrieve({ entity: subject, topic: rule.topic === '*' ? undefined : rule.topic, requester }, now)
        .filter((h) => rule.entity_ids.includes(h.entity) || rule.memory_keys.some((k) => h.id.endsWith(k) || h.entity === k) || rule.topic === '*');
      const scoped = hits.filter((h) => rule.entity_ids.includes(h.entity) || rule.memory_keys.includes(h.id) || rule.memory_keys.includes(h.entity));
      const pool = scoped.length > 0 ? scoped : [];
      const counts = { fresh: 0, stale: 0, unknown: 0, total: pool.length };
      for (const h of pool) {
        const f = this.freshnessOf(h, now);
        if (f === 'FRESH' || f === 'AGING') counts.fresh++;
        else if (f === 'STALE') counts.stale++;
        else counts.unknown++;
      }
      const contents = new Set(pool.filter((h) => h.validation !== 'unvalidated').map((h) => stableStringify((h.record as { data?: unknown; content?: unknown }).data ?? (h.record as { content?: unknown }).content)));
      const marked = this.markersFor(subject, `${rule.topic}:${subject}`);
      const staleMarked = marked.some((m) => ['STALE', 'SUPERSEDED', 'INVALIDATED'].includes((m.content as { status?: string }).status ?? ''));
      let status: GapStatus = 'MISSING';
      if (pool.length === 0) status = 'MISSING';
      else if (contents.size > 1) status = 'CONFLICTED';
      else if (staleMarked) status = 'STALE';
      else if (counts.fresh > 0) status = 'KNOWN';
      else if (counts.stale > 0) status = 'STALE';
      else status = 'UNKNOWN';
      return { topic: rule.topic, status, counts };
    });
  }

  budgetInfo(subject: string, topics: TopicRule[] = [], now = Date.now()): { estimated_effort: number; basis: string; evidence_count: number; fresh_count: number; stale_count: number; research_history: { task_id: string; status: string }[]; missing: string[] } {
    const hits = this.retrieve({ entity: subject }, now);
    let fresh = 0;
    let stale = 0;
    for (const h of hits) {
      const f = this.freshnessOf(h, now);
      if (f === 'FRESH' || f === 'AGING') fresh++;
      else if (f === 'STALE') stale++;
    }
    const history = this.findTasks({ subject }).map((t) => ({ task_id: t.task_id, status: t.status }));
    const missing = topics.length > 0 ? this.gapReport(subject, topics, now).filter((g) => g.status === 'MISSING' || g.status === 'STALE').map((g) => g.topic) : [];
    const estimated_effort = Math.min(5, 1 + stale + missing.length);
    return {
      estimated_effort,
      basis: `heuristic: 1 base + ${stale} stale + ${missing.length} missing (cap 5)`,
      evidence_count: hits.length,
      fresh_count: fresh,
      stale_count: stale,
      research_history: history,
      missing
    };
  }

  // -- structured memory writers -----------------------------------------------------

  recordAgentMemory(input: Record<string, unknown>, actor: string, now = Date.now()): string {
    for (const f of ['agent', 'task_id', 'actions', 'sources', 'conclusions', 'confidence', 'lessons', 'knowledge_version']) {
      if (input[f] === undefined) throw new Error(`AGENT_MEMORY_MISSING_FIELD: ${f}`);
    }
    const agent = String(input['agent']);
    const key = `agent:${agent}:${String(input['task_id'])}`;
    this.knowledge.proposeValidateCommit({
      assertion: 'OBSERVATION',
      ops: [{ op: 'put-memory', memory: { category: 'agent', key, content: { ...input, domain: 'research' } } }],
      provenance: { source: 'agent-memory', source_type: 'agent', source_identifier: key, observed_at: now, agent: actor, evidence_refs: [String(input['task_id'])], confidence: 1 },
      actor
    });
    return key;
  }

  recordTradingExperience(input: Record<string, unknown>, actor: string, now = Date.now()): string {
    for (const f of ['experience_id', 'decision', 'context', 'strategy', 'risk_state', 'outcome']) {
      if (input[f] === undefined) throw new Error(`EXPERIENCE_MISSING_FIELD: ${f}`);
    }
    const key = `experience:${String(input['experience_id'])}`;
    this.knowledge.proposeValidateCommit({
      assertion: 'OBSERVATION',
      ops: [{ op: 'put-memory', memory: { category: 'trading-experience', key, content: { ...input, domain: 'research' } } }],
      provenance: { source: 'trading-experience', source_type: 'agent', source_identifier: key, observed_at: now, agent: actor, evidence_refs: [String(input['experience_id'])], confidence: 1 },
      actor
    });
    return key;
  }

  // -- market integration ---------------------------------------------------------------

  observeMarket(record: MarketRecord, report: QualityReport, actor: string): { action: 'COMMITTED' | 'NOTED' | 'IGNORED'; ref: string } {
    const ref = recordId(record);
    if (report.verdict === 'VALID') {
      const price = record.kind === 'bar' ? record.close : (record.price ?? record.bid ?? record.ask ?? 0);
      this.knowledge.proposeValidateCommit({
        assertion: 'OBSERVATION',
        ops: [{ op: 'upsert-node', node: { id: `observation:price:${record.instrument_id}:${record.ts}`, kind: 'Observation', label: `price ${record.instrument_id}`, data: { entity: record.instrument_id, topic: 'price', domain: 'price', price, provider: record.provider, quality: 'VALID' } } }],
        provenance: { source: record.provider, source_type: 'market-data', source_identifier: ref, observed_at: record.ts, agent: actor, evidence_refs: [ref], confidence: 0.9 },
        actor
      });
      return { action: 'COMMITTED', ref };
    }
    if (report.verdict === 'SUSPECT') {
      this.knowledge.proposeValidateCommit({
        assertion: 'HYPOTHESIS',
        ops: [{ op: 'put-memory', memory: { category: 'evidence', key: `suspect:${ref}`, content: { entity: record.instrument_id, topic: 'price', domain: 'price', record: ref, reasons: report.reasons } } }],
        provenance: { source: record.provider, source_type: 'market-data', source_identifier: ref, observed_at: record.ts, agent: actor, evidence_refs: [ref], confidence: 0.5 },
        actor
      });
      return { action: 'NOTED', ref };
    }
    return { action: 'IGNORED', ref };
  }

  applyMarketEvent(event: MarketEvent, actor: string, now = Date.now()): string[] {
    const topics = invalidationTopicsFor(event.event_type);
    const targets = new Set<string>();
    for (const ref of [...event.entity_refs, ...event.instrument_ids.map((id) => `instrument:${id}`)]) {
      targets.add(ref);
      for (const t of topics) targets.add(`${t}:${ref}`);
    }
    return this.invalidate({ targets: [...targets], cause: `market-event:${event.event_type}:${event.event_id}`, eventRef: event.event_id, actor, status: 'STALE', now });
  }

  // -- agent context (redacted, ACL-enforced) ------------------------------------------------

  buildAgentContext(requester: string, request: ReuseRequest, limit = 20): { decision: ReuseDecisionValue; basis: string[]; records: unknown[] } {
    const decision = this.decide({ ...request, agent: requester });
    const hits = this.retrieve({ entity: request.subject, topic: request.topic, requester, limit }, request.now);
    return {
      decision: decision.decision,
      basis: decision.basis,
      records: hits.map((h) => redact(h.record))
    };
  }
}

export { MEMORY_FRESHNESS };
export type { MemoryDomain, MemoryFreshness };
