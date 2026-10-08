// SyncManager — AURIX sync semantics. Transport moves opaque files; this engine
// understands, validates, detects divergence/conflicts, and merges.
// Knowledge writes go ONLY through KnowledgeStore (propose/validate/commit,
// replay). Sync metadata lives in memory tables (deterministically rebuildable)
// + small JSON files (identity, trust, store id). Knowledge + files are durable.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { KnowledgeEvent } from '@aurix/contracts';
import type { MemoryRecord } from '@aurix/contracts';
import type {
  ConflictRecord,
  DryRunReport,
  KnowledgeTransferTransport,
  ResolutionAction,
  SyncEnvelope,
  SyncManifest,
  TransferFile,
  TrustEntry,
  VersionVector
} from '@aurix/sync-protocol';
import { checkSchemaCompat, isValidPackageName, triageVectors } from '@aurix/sync-protocol';
import {
  KnowledgeStore,
  MemoryTables,
  SCHEMA_VERSION,
  containsSecretPayload,
  cyrb53hex,
  stableStringify
} from '@aurix/knowledge-service';
import type { KnowledgeTables, Row } from '@aurix/knowledge-service';
import { createLogger, type Logger } from '@aurix/observability';
import { ensureIdentity, type IdentityStore } from './identity.js';
import { edSign, edVerify, openSealed, sealToRecipient, sha256hexText } from './crypto.js';

export const EVENT_SCHEMA_VERSION = 'kev-1';
export const PACKAGE_VERSION = 'sync-pkg-1';
const SYNC_SUFFIX = '.akpkg.json';

export class SyncError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SyncError';
  }
}

export interface SyncManagerOptions {
  knowledge: KnowledgeStore;
  tables: KnowledgeTables;
  syncDir: string;
  clock?: () => number;
  quarantineUnknown?: boolean;
  onBeforeApply?: (eventId: string) => void;
  /** Local schema version (defaults to graph-v1). Override only for compat tests. */
  schemaVersion?: string;
}

interface InnerPackage {
  events: KnowledgeEvent[];
  envelopes: SyncEnvelope[];
  nodes: Row[];
  edges: Row[];
  provenance: Row[];
  memories: MemoryRecord[];
  embeddings: Row[];
}

interface InspectedPackage {
  fileName: string;
  manifest: SyncManifest;
  inner: InnerPackage;
  compat: 'COMPATIBLE' | 'UPGRADE_REQUIRED';
}

export interface MergeResult {
  outcome: 'AUTO_MERGE' | 'CONFLICT' | 'REJECT';
  packageId: string;
  applied: string[];
  deferred: string[];
  conflictIds: string[];
  reason: string | null;
}

function corr(): string {
  return `corr-${randomBytes(4).toString('hex')}`;
}

export class SyncManager {
  private identity: IdentityStore;
  private storeId: string;
  private trust = new Map<string, TrustEntry>();
  private syncTables = new MemoryTables();
  private logger: Logger;
  private clock: () => number;
  private quarantineUnknown: boolean;
  private onBeforeApply?: (eventId: string) => void;
  private knowledge: KnowledgeStore;
  private tables: KnowledgeTables;
  private syncDir: string;
  private localSchema: string;

  constructor(opts: SyncManagerOptions) {
    this.knowledge = opts.knowledge;
    this.tables = opts.tables;
    this.syncDir = opts.syncDir;
    this.clock = opts.clock ?? (() => Date.now());
    this.quarantineUnknown = opts.quarantineUnknown ?? false;
    this.onBeforeApply = opts.onBeforeApply;
    this.localSchema = opts.schemaVersion ?? SCHEMA_VERSION;
    mkdirSync(opts.syncDir, { recursive: true });
    this.identity = ensureIdentity(opts.syncDir);
    this.storeId = this.ensureStoreId();
    this.loadTrust();
    this.logger = createLogger(join(opts.syncDir, 'audit.log'), 'sync-manager');
  }

  get deviceId(): string { return this.identity.identity.device_id; }
  get installationId(): string { return this.identity.identity.installation_id; }
  get knowledgeStoreId(): string { return this.storeId; }

  // -- identity / store / trust ------------------------------------------------

  private ensureStoreId(): string {
    const f = join(this.syncDir, 'store.json');
    if (existsSync(f)) {
      const s = JSON.parse(readFileSync(f, 'utf8')) as { knowledge_store_id: string };
      if (s.knowledge_store_id) return s.knowledge_store_id;
      throw new SyncError('STORE_ID_CORRUPT', f);
    }
    const id = `ks-${randomBytes(16).toString('hex')}`;
    writeFileSync(f, JSON.stringify({ knowledge_store_id: id, created_at: this.clock() }, null, 2), { mode: 0o600 });
    return id;
  }

  private trustFile(): string { return join(this.syncDir, 'trust.json'); }

  private loadTrust(): void {
    const f = this.trustFile();
    if (!existsSync(f)) return;
    const list = (JSON.parse(readFileSync(f, 'utf8')) as { entries: TrustEntry[] }).entries ?? [];
    for (const e of list) this.trust.set(e.device_id, e);
  }

  private saveTrust(): void {
    writeFileSync(this.trustFile(), JSON.stringify({ entries: [...this.trust.values()] }, null, 2), { mode: 0o600 });
  }

  addTrust(entry: TrustEntry): void {
    if (!entry.device_id || !entry.ed25519_public || !entry.x25519_public) {
      throw new SyncError('BAD_TRUST_ENTRY', 'trust entry incomplete');
    }
    this.trust.set(entry.device_id, { ...entry, status: 'ACTIVE' });
    this.saveTrust();
    this.audit('trust.added', { deviceId: entry.device_id });
  }

  getTrust(deviceId: string): TrustEntry | undefined {
    const t = this.trust.get(deviceId);
    return t && t.status === 'ACTIVE' ? t : undefined;
  }

  /** Public trust advertisement (public keys only — safe to share). */
  exportPublicTrust(): TrustEntry {
    return {
      device_id: this.deviceId,
      installation_id: this.installationId,
      ed25519_public: this.identity.keys.ed25519_public,
      x25519_public: this.identity.keys.x25519_public,
      added_at: this.clock(),
      status: 'ACTIVE'
    };
  }

  // -- envelopes / vectors ----------------------------------------------------

  /** Deterministically (re)build envelopes for all local events. Idempotent. */
  assignEnvelopes(): SyncEnvelope[] {
    const events = this.knowledge.eventsAfter(0);
    const counters = this.originCounters();
    let tip: string | null = this.lastTip(events);
    for (const e of events) {
      const known = this.syncTables.get('event_sync', e.id);
      if (known) {
        tip = e.id;
        continue;
      }
      const origin = e.device_id;
      const seq = (counters[origin] ?? 0) + 1;
      counters[origin] = seq;
      const env: SyncEnvelope = { event_id: e.id, origin_device: origin, origin_seq: seq, parents: tip ? [tip] : [], created_at: e.created_at };
      this.syncTables.insert('event_sync', { id: env.event_id, origin_device: env.origin_device, origin_seq: env.origin_seq, parents_json: JSON.stringify(env.parents), created_at: env.created_at });
      tip = e.id;
    }
    this.syncTables.query('sync_state', (r) => r['id'] === 'origin_counters').length === 0
      ? this.syncTables.insert('sync_state', { id: 'origin_counters', value_json: JSON.stringify(counters) })
      : this.syncTables.update('sync_state', 'origin_counters', { value_json: JSON.stringify(counters) });
    return this.allEnvelopes();
  }

  private originCounters(): Record<string, number> {
    const r = this.syncTables.get('sync_state', 'origin_counters');
    return r ? (JSON.parse(String(r['value_json'])) as Record<string, number>) : {};
  }

  private lastTip(events: KnowledgeEvent[]): string | null {
    return events.length > 0 ? events[events.length - 1]!.id : null;
  }

  private allEnvelopes(): SyncEnvelope[] {
    return this.syncTables
      .query('event_sync')
      .map((r) => ({ event_id: String(r['id']), origin_device: String(r['origin_device']), origin_seq: Number(r['origin_seq']), parents: JSON.parse(String(r['parents_json'])) as string[], created_at: Number(r['created_at']) }))
      .sort((a, b) => a.created_at - b.created_at || (a.event_id < b.event_id ? -1 : 1));
  }

  versionVector(): VersionVector {
    this.assignEnvelopes(); // keep causal metadata current (idempotent, deterministic)
    const vv: VersionVector = {};
    for (const e of this.allEnvelopes()) vv[e.origin_device] = Math.max(vv[e.origin_device] ?? 0, e.origin_seq);
    return vv;
  }

  envelopeOf(eventId: string): SyncEnvelope | undefined {
    const r = this.syncTables.get('event_sync', eventId);
    return r ? { event_id: eventId, origin_device: String(r['origin_device']), origin_seq: Number(r['origin_seq']), parents: JSON.parse(String(r['parents_json'])) as string[], created_at: Number(r['created_at']) } : undefined;
  }

  // -- package creation -------------------------------------------------------

  selectEvents(peerVV: VersionVector | null): { events: KnowledgeEvent[]; envelopes: SyncEnvelope[] } {
    this.assignEnvelopes();
    const envById = new Map(this.allEnvelopes().map((e) => [e.event_id, e]));
    const events = this.knowledge.eventsAfter(0).filter((e) => {
      const env = envById.get(e.id);
      if (!env) return false;
      if (!peerVV) return true;
      return env.origin_seq > (peerVV[env.origin_device] ?? 0);
    });
    const ids = new Set(events.map((e) => e.id));
    return { events, envelopes: this.allEnvelopes().filter((e) => ids.has(e.event_id)) };
  }

  createPackage(recipientDeviceId: string, peerVV: VersionVector | null = null, correlationId = corr()): { packageId: string; fileName: string; content: string } {
    const recipient = this.getTrust(recipientDeviceId);
    if (!recipient) throw new SyncError('NO_TRUST', `no trust entry for ${recipientDeviceId}`);
    const { events, envelopes } = this.selectEvents(peerVV);
    if (events.length === 0) throw new SyncError('NOTHING_TO_SYNC', 'peer is up to date');
    const inner = this.buildInner(events);
    if (containsSecretPayload(inner)) throw new SyncError('SECRET_DETECTED', 'refusing to package secret-shaped material');
    const vv = this.versionVector();
    const ranges = this.computeRanges(envelopes);
    const contentHash = sha256hexText(stableStringify(inner));
    const packageId = `pkg-${contentHash.slice(0, 16)}`;
    const manifest: SyncManifest = {
      package_id: packageId,
      sender_device_id: this.deviceId,
      sender_installation_id: this.installationId,
      knowledge_store_id: this.storeId,
      schema_version: SCHEMA_VERSION,
      event_schema_version: EVENT_SCHEMA_VERSION,
      package_version: PACKAGE_VERSION,
      created_at: this.clock(),
      knowledge_state_version: this.knowledge.knowledgeVersion(),
      version_vector: vv,
      ranges,
      event_count: events.length,
      content_hash: contentHash,
      package_hash: '',
      crypto: { version: 'gcm-ed25519-v1', iv: '', ephemeral_pub: '', tag: '' },
      signature: ''
    };
    const plaintext = Buffer.from(stableStringify(inner), 'utf8');
    const sealed = sealToRecipient(recipient.x25519_public, plaintext);
    manifest.crypto = { version: 'gcm-ed25519-v1', iv: sealed.iv, ephemeral_pub: sealed.ephemeral_pub, tag: sealed.tag };
    const encrypted = Buffer.from(stableStringify({ iv: sealed.iv, ciphertext: sealed.ciphertext, tag: sealed.tag }), 'utf8').toString('base64');
    const signable = this.signableManifest(manifest);
    manifest.package_hash = sha256hexText(stableStringify({ manifest: signable, encrypted, ephemeral_pub: sealed.ephemeral_pub }));
    manifest.signature = edSign(this.identity.keys.ed25519_private, Buffer.from(signable, 'utf8'));
    const file: TransferFile = { manifest, encrypted, ephemeral_pub: sealed.ephemeral_pub };
    const content = stableStringify(file);
    this.audit('package.created', { packageId, recipient: recipientDeviceId, events: events.length, correlationId });
    return { packageId, fileName: `${packageId}${SYNC_SUFFIX}`, content };
  }

  private signableManifest(m: SyncManifest): string {
    const { signature, package_hash: _ph, ...rest } = m;
    void _ph;
    void signature;
    return stableStringify({ ...rest, signature: null, package_hash: null });
  }

  private computeRanges(envelopes: SyncEnvelope[]): { origin_device: string; from_seq: number; to_seq: number; count: number }[] {
    const byOrigin = new Map<string, number[]>();
    for (const e of envelopes) {
      const list = byOrigin.get(e.origin_device) ?? [];
      list.push(e.origin_seq);
      byOrigin.set(e.origin_device, list);
    }
    return [...byOrigin.entries()]
      .map(([origin_device, seqs]) => {
        seqs.sort((a, b) => a - b);
        return { origin_device, from_seq: seqs[0]!, to_seq: seqs[seqs.length - 1]!, count: seqs.length };
      })
      .sort((a, b) => (a.origin_device < b.origin_device ? -1 : 1));
  }

  private buildInner(events: KnowledgeEvent[]): InnerPackage {
    const refs = new Set<string>();
    for (const e of events) {
      refs.add(e.entity_ref);
      const payload = e.payload as { ops?: { op: string; node?: { id: string }; edge?: { src: string; dst: string } }[] };
      for (const op of payload.ops ?? []) {
        if (op.op === 'upsert-node' && op.node) refs.add(op.node.id);
        if (op.op === 'add-edge' && op.edge) { refs.add(op.edge.src); refs.add(op.edge.dst); }
      }
    }
    const nodes: Row[] = [];
    const edges: Row[] = [];
    for (const id of refs) {
      const n = this.knowledge.getEntity(id);
      if (n) nodes.push({ ...n });
      for (const e of this.knowledge.getEdges(id)) {
        if (!edges.some((x) => x['id'] === e.id)) edges.push({ ...e });
      }
    }
    nodes.sort((a, b) => (String(a['id']) < String(b['id']) ? -1 : 1));
    edges.sort((a, b) => (String(a['id']) < String(b['id']) ? -1 : 1));
    const allProv: Row[] = [];
    for (const id of refs) {
      for (const p of this.knowledge.provenanceChain(id)) {
        if (!allProv.some((x) => x['id'] === p['id'])) allProv.push(p);
      }
    }
    const eventIds = new Set(events.map((e) => e.id));
    const seqs = new Set(events.map((e) => this.kvSeq(e)));
    const memories = this.knowledge.snapshotMemories().filter((m) => eventIds.has(m.event_id));
    const embeddings = this.knowledge.snapshotEmbeddings().filter((r) => seqs.has(Number(r['knowledge_version'])));
    const envelopes = this.allEnvelopes().filter((e) => eventIds.has(e.event_id));
    return { events, envelopes, nodes, edges, provenance: allProv, memories, embeddings };
  }

  private kvSeq(e: KnowledgeEvent): number {
    const m = /^kv-(\d+)$/.exec(e.new_version);
    return m ? Number(m[1]) : 0;
  }

  // -- discovery + inspection (no knowledge mutation) --------------------------

  discover(t: KnowledgeTransferTransport, correlationId = corr()): { name: string; status: 'READY' | 'REJECTED'; reason: string | null; manifest?: SyncManifest }[] {
    const out: { name: string; status: 'READY' | 'REJECTED'; reason: string | null; manifest?: SyncManifest }[] = [];
    for (const name of t.listIncoming()) {
      try {
        const inspected = this.inspectFileContent(name, t.readIncoming(name));
        this.audit('package.discovered', { packageId: inspected.manifest.package_id, name, correlationId });
        out.push({ name, status: 'READY', reason: null, manifest: inspected.manifest });
      } catch (e) {
        const reason = e instanceof SyncError ? `${e.code}: ${e.message}` : String(e);
        t.markRejected(name);
        this.audit('package.rejected', { packageId: null, name, reason, correlationId });
        out.push({ name, status: 'REJECTED', reason });
      }
    }
    return out;
  }

  inspectFileContent(fileName: string, content: string): InspectedPackage {
    if (!isValidPackageName(fileName)) throw new SyncError('BAD_FILE', `invalid package name ${fileName}`);
    let file: TransferFile;
    try {
      file = JSON.parse(content) as TransferFile;
    } catch {
      throw new SyncError('MALFORMED', 'package is not valid JSON');
    }
    const m = file.manifest;
    if (!m || typeof m !== 'object') throw new SyncError('BAD_MANIFEST', 'missing manifest');
    if (`${m.package_id}${SYNC_SUFFIX}` !== fileName) throw new SyncError('MANIFEST_MISMATCH', 'filename/package_id mismatch');
    for (const f of ['sender_device_id', 'knowledge_store_id', 'schema_version', 'event_count', 'content_hash', 'package_hash', 'signature'] as const) {
      if (m[f] === undefined || m[f] === null || m[f] === '') throw new SyncError('BAD_MANIFEST', `missing ${f}`);
    }
    const compat = checkSchemaCompat(m.schema_version, this.localSchema);
    if (compat === 'UNSUPPORTED') throw new SyncError('SCHEMA_CONFLICT', `sender ${m.schema_version} vs local ${this.localSchema}`);
    if (m.event_schema_version !== EVENT_SCHEMA_VERSION) throw new SyncError('SCHEMA_CONFLICT', `event schema ${m.event_schema_version}`);
    const sender = this.getTrust(m.sender_device_id);
    if (!sender) {
      if (this.quarantineUnknown) throw new SyncError('PENDING_TRUST', `unknown device ${m.sender_device_id} quarantined`);
      throw new SyncError('TRUST_CONFLICT', `unknown device ${m.sender_device_id}`);
    }
    if (!edVerify(sender.ed25519_public, Buffer.from(this.signableManifest(m), 'utf8'), m.signature)) {
      throw new SyncError('BAD_SIGNATURE', 'signature verification failed');
    }
    let innerJson: string;
    try {
      const parts = JSON.parse(Buffer.from(file.encrypted, 'base64').toString('utf8')) as { iv: string; ciphertext: string; tag: string };
      innerJson = openSealed(this.identity.keys.x25519_private, { ephemeral_pub: file.ephemeral_pub, ...parts }).toString('utf8');
    } catch (e) {
      if (e instanceof SyncError) throw e;
      throw new SyncError('DECRYPT_FAILED', 'authenticated decryption failed (wrong key or tampered bytes)');
    }
    let inner: InnerPackage;
    try {
      inner = JSON.parse(innerJson) as InnerPackage;
    } catch {
      throw new SyncError('MALFORMED', 'inner payload is not valid JSON');
    }
    if (sha256hexText(stableStringify(inner)) !== m.content_hash) throw new SyncError('CHECKSUM_MISMATCH', 'content hash mismatch');
    const recomputedPkg = sha256hexText(stableStringify({ manifest: this.signableManifest(m), encrypted: file.encrypted, ephemeral_pub: file.ephemeral_pub }));
    if (recomputedPkg !== m.package_hash) throw new SyncError('CHECKSUM_MISMATCH', 'package hash mismatch');
    this.checkRanges(m, inner);
    if (containsSecretPayload(inner)) throw new SyncError('SECRET_DETECTED', 'secret-shaped material in package');
    return { fileName, manifest: m, inner, compat: compat === 'COMPATIBLE' ? 'COMPATIBLE' : 'UPGRADE_REQUIRED' };
  }

  private checkRanges(m: SyncManifest, inner: InnerPackage): void {
    const envById = new Map(inner.envelopes.map((e) => [e.event_id, e]));
    if (envById.size !== inner.events.length) throw new SyncError('INCOMPLETE_RANGE', 'events/envelopes mismatch');
    for (const e of inner.events) {
      if (!envById.has(e.id)) throw new SyncError('INCOMPLETE_RANGE', `missing envelope for ${e.id}`);
    }
    for (const r of m.ranges) {
      const seqs = inner.envelopes.filter((e) => e.origin_device === r.origin_device).map((e) => e.origin_seq).sort((a, b) => a - b);
      if (seqs.length !== r.count || seqs[0] !== r.from_seq || seqs[seqs.length - 1] !== r.to_seq) {
        throw new SyncError('INCOMPLETE_RANGE', `range mismatch for ${r.origin_device}`);
      }
      for (let i = 1; i < seqs.length; i++) {
        if (seqs[i]! - seqs[i - 1]! !== 1) throw new SyncError('INCOMPLETE_RANGE', `gap in ${r.origin_device} range`);
      }
    }
  }

  // -- dry-run (zero mutations) ---------------------------------------------------

  dryRun(inspected: InspectedPackage): DryRunReport {
    const localIds = new Set(this.knowledge.eventsAfter(0).map((e) => e.id));
    const deferredIds = new Set(this.syncTables.query('deferred_events').map((r) => String(r['id'])));
    const newNodeIds = new Set<string>();
    const newEvents: string[] = [];
    const duplicateEvents: string[] = [];
    const newEntities = new Set<string>();
    const newRelationships = new Set<string>();
    const updatedEntities = new Set<string>();
    const expiredRelationships = new Set<string>();
    const unsupportedEvents: string[] = [];
    const securityFailures: string[] = [];
    const conflictBuckets = new Map<string, { localEvent: string | null; remote: string[] }>();

    for (const e of inspected.inner.events) {
      if (localIds.has(e.id) || deferredIds.has(e.id)) {
        if (localIds.has(e.id)) {
          const local = this.knowledge.eventsAfter(0).find((x) => x.id === e.id);
          if (local && stableStringify(local.payload) !== stableStringify(e.payload)) {
            securityFailures.push(`tampered-known-event:${e.id}`);
            continue;
          }
        }
        duplicateEvents.push(e.id);
        continue;
      }
      if (e.event_type !== 'knowledge.commit') {
        unsupportedEvents.push(e.id);
        continue;
      }
      const payload = e.payload as { ops?: { op: string; node?: { id: string; kind: string; label: string; data: Record<string, unknown> }; edge?: { src: string; dst: string; rel: string; data?: Record<string, unknown>; confidence?: number } }[] };
      let conflicting = false;
      for (const op of payload.ops ?? []) {
        if (op.op === 'upsert-node' && op.node) {
          const local = this.knowledge.getEntity(op.node.id);
          if (!local) {
            newEntities.add(op.node.id);
            newNodeIds.add(op.node.id);
          } else if (this.sameNode(local, op.node)) {
            // identical: no-op
          } else {
            updatedEntities.add(op.node.id);
            conflicting = true;
            this.bucketConflict(conflictBuckets, op.node.id, e.id);
          }
        } else if (op.op === 'add-edge' && op.edge) {
          const triple = `${op.edge.src}|${op.edge.rel}|${op.edge.dst}`;
          const active = this.knowledge.getEdges(op.edge.src, { direction: 'out' }).find((x) => x.dst === op.edge!.dst && x.rel === op.edge!.rel && x.status === 'ACTIVE');
          const endpointsKnown = this.endpointKnown(op.edge.src, op.edge.dst, newNodeIds);
          if (!endpointsKnown) {
            unsupportedEvents.push(`${e.id}:missing-endpoint:${triple}`);
            conflicting = true;
          } else if (!active) {
            newRelationships.add(triple);
          } else if (this.sameEdge(active, op.edge)) {
            // identical: no-op
          } else {
            expiredRelationships.add(triple);
            conflicting = true;
            this.bucketConflict(conflictBuckets, `edge:${triple}`, e.id);
          }
        }
      }
      if (!unsupportedEvents.some((u) => u.startsWith(e.id))) {
        newEvents.push(e.id);
      }
    }

    const conflicts: ConflictRecord[] = [];
    for (const [entityRef, b] of conflictBuckets) {
      conflicts.push(this.buildConflict(entityRef, b.localEvent, b.remote, inspected));
    }
    return {
      newEvents,
      duplicateEvents,
      newEntities: [...newEntities].sort(),
      newRelationships: [...newRelationships].sort(),
      updatedEntities: [...updatedEntities].sort(),
      expiredRelationships: [...expiredRelationships].sort(),
      conflicts,
      schemaDiff: { sender: inspected.manifest.schema_version, local: this.localSchema, verdict: inspected.compat === 'COMPATIBLE' ? 'COMPATIBLE' : 'UPGRADE_REQUIRED' },
      unsupportedEvents,
      securityFailures,
      triage: triageVectors(this.versionVector(), inspected.manifest.version_vector)
    };
  }

  private sameNode(local: { kind: string; label: string; data: Record<string, unknown> }, incoming: { kind: string; label: string; data: Record<string, unknown> }): boolean {
    return local.kind === incoming.kind && local.label === incoming.label && stableStringify(local.data) === stableStringify(incoming.data);
  }

  private sameEdge(local: { data: Record<string, unknown>; confidence: number }, incoming: { data?: Record<string, unknown>; confidence?: number }): boolean {
    return stableStringify(local.data) === stableStringify(incoming.data ?? {}) && local.confidence === (incoming.confidence ?? 0.5);
  }

  private endpointKnown(src: string, dst: string, newNodeIds: Set<string>): boolean {
    return (!!this.knowledge.getEntity(src) || newNodeIds.has(src)) && (!!this.knowledge.getEntity(dst) || newNodeIds.has(dst));
  }

  private bucketConflict(buckets: Map<string, { localEvent: string | null; remote: string[] }>, entityRef: string, remoteEventId: string): void {
    const b = buckets.get(entityRef) ?? { localEvent: this.latestLocalEvent(entityRef), remote: [] };
    if (!b.remote.includes(remoteEventId)) b.remote.push(remoteEventId);
    buckets.set(entityRef, b);
  }

  private latestLocalEvent(entityRef: string): string | null {
    if (entityRef.startsWith('edge:')) {
      const [, triple] = entityRef.split(':');
      const [src, rel, dst] = (triple ?? '').split('|');
      const rows = this.knowledge.getEdges(src ?? '', { direction: 'out', includeExpired: true })
        .filter((e) => e.dst === dst && e.rel === (rel as never));
      rows.sort((a, b) => a.created_at - b.created_at);
      return rows.length > 0 ? rows[rows.length - 1]!.event_id : null;
    }
    const hist = this.knowledge.entityHistory(entityRef);
    return hist.length > 0 ? String(hist[hist.length - 1]!['event_id']) : null;
  }

  private buildConflict(entityRef: string, localEvent: string | null, remote: string[], inspected: InspectedPackage): ConflictRecord {
    const remoteSorted = [...remote].sort();
    const conflictId = `cf-${cyrb53hex(`${entityRef}|${[localEvent ?? '', ...remoteSorted].join(',')}`)}`;
    const provA = this.knowledge.provenanceChain(entityRef.startsWith('edge:') ? (entityRef.split(':')[1] ?? '').split('|')[0] ?? '' : entityRef)
      .map((r) => String(r['id']));
    const provB: string[] = [];
    for (const id of remoteSorted) {
      const ev = inspected.inner.events.find((e) => e.id === id);
      if (ev) provB.push(...ev.evidence_refs);
      for (const p of inspected.inner.provenance) {
        if (String(p['entity_ref']) === entityRef || (ev && p['entity_ref'] === ev.entity_ref)) provB.push(String(p['id']));
      }
    }
    return {
      conflict_id: conflictId,
      entity_ref: entityRef,
      local_event_id: localEvent,
      remote_event_ids: remoteSorted,
      assertion_a: 'local-state',
      assertion_b: 'remote-state',
      provenance_a: [...new Set(provA)].sort(),
      provenance_b: [...new Set(provB)].sort(),
      device_a: this.deviceId,
      device_b: inspected.manifest.sender_device_id,
      detected_at: this.clock(),
      status: 'UNRESOLVED',
      resolution: null,
      resolved_at: null,
      resolution_event_id: null
    };
  }

  // -- import / merge (transactional) ------------------------------------------------

  importPackage(t: KnowledgeTransferTransport, fileName: string, correlationId = corr()): MergeResult {
    this.audit('import.started', { packageId: fileName, correlationId });
    let inspected: InspectedPackage;
    try {
      inspected = this.inspectFileContent(fileName, t.readIncoming(fileName));
    } catch (e) {
      const reason = e instanceof SyncError ? `${e.code}: ${e.message}` : String(e);
      t.markRejected(fileName);
      this.audit('package.rejected', { packageId: fileName, reason, correlationId });
      return { outcome: 'REJECT', packageId: fileName, applied: [], deferred: [], conflictIds: [], reason };
    }
    const pkgId = inspected.manifest.package_id;
    const report = this.dryRun(inspected);
    if (report.securityFailures.length > 0 || report.unsupportedEvents.length > 0) {
      const reason = `unsafe package: ${[...report.securityFailures, ...report.unsupportedEvents].join('; ')}`;
      t.markRejected(fileName);
      this.audit('package.rejected', { packageId: pkgId, reason, correlationId });
      return { outcome: 'REJECT', packageId: pkgId, applied: [], deferred: [], conflictIds: [], reason };
    }
    const byId = new Map(inspected.inner.events.map((e) => [e.id, e]));
    const conflictingIds = new Set(report.conflicts.flatMap((c) => c.remote_event_ids));
    const autoIds = report.newEvents.filter((id) => !conflictingIds.has(id));
    const cp = this.checkpoint();
    const applied: string[] = [];
    const deferred: string[] = [];
    try {
      for (const id of autoIds) {
        this.onBeforeApply?.(id);
        this.knowledge.replay([byId.get(id)!]);
        this.syncTables.insert('import_log', { id: `${pkgId}:${id}`, package_id: pkgId, event_id: id, outcome: 'APPLIED', applied_at: this.clock() });
        applied.push(id);
      }
      const conflictIds: string[] = [];
      for (const c of report.conflicts) {
        const recorded = this.recordConflict(c, pkgId, inspected);
        if (recorded.status !== 'UNRESOLVED') continue; // previously resolved: nothing to defer
        conflictIds.push(recorded.conflict_id);
        for (const rid of recorded.remote_event_ids) {
          const ev = byId.get(rid)!;
          const env = inspected.inner.envelopes.find((x) => x.event_id === rid)!;
          if (!this.syncTables.get('deferred_events', rid)) {
            this.syncTables.insert('deferred_events', { id: rid, package_id: pkgId, conflict_id: recorded.conflict_id, event_json: stableStringify(ev), envelope_json: stableStringify(env), received_at: this.clock() });
          }
          this.syncTables.insert('import_log', { id: `${pkgId}:${rid}`, package_id: pkgId, event_id: rid, outcome: 'DEFERRED', applied_at: this.clock() });
          deferred.push(rid);
        }
      }
      t.markProcessed(fileName);
      const outcome = conflictIds.length > 0 ? 'CONFLICT' : 'AUTO_MERGE';
      this.audit('merge.completed', { packageId: pkgId, outcome, applied: applied.length, deferred: deferred.length, correlationId });
      return { outcome, packageId: pkgId, applied, deferred, conflictIds, reason: null };
    } catch (e) {
      this.rollback(cp);
      const reason = e instanceof Error ? e.message : String(e);
      this.audit('merge.failed', { packageId: pkgId, reason, correlationId });
      return { outcome: 'REJECT', packageId: pkgId, applied: [], deferred: [], conflictIds: [], reason };
    }
  }

  private recordConflict(c: ConflictRecord, pkgId: string, inspected: InspectedPackage): ConflictRecord {
    void pkgId;
    void inspected;
    const existing = this.syncTables.get('conflicts', c.conflict_id);
    if (existing) {
      if (this.rowToConflict(existing).status === 'RESOLVED') return this.rowToConflict(existing);
      const known = JSON.parse(String(existing['remote_event_ids_json'])) as string[];
      const merged = [...new Set([...known, ...c.remote_event_ids])].sort();
      this.syncTables.update('conflicts', c.conflict_id, { remote_event_ids_json: JSON.stringify(merged) });
      return this.getConflict(c.conflict_id);
    }
    // Restart durability: a resolution knowledge event may already exist.
    const resolutionNode = this.knowledge.getEntity(`conflict:${c.conflict_id}`);
    if (resolutionNode) {
      const data = resolutionNode.data as { action?: ResolutionAction };
      const restored: ConflictRecord = { ...c, status: 'RESOLVED', resolution: data.action ?? 'ACCEPT_A', resolved_at: resolutionNode.created_at, resolution_event_id: resolutionNode.event_id };
      this.syncTables.insert('conflicts', this.conflictRow(restored));
      return restored;
    }
    this.syncTables.insert('conflicts', this.conflictRow(c));
    this.audit('conflict.detected', { conflictId: c.conflict_id, entity: c.entity_ref });
    return c;
  }

  private conflictRow(c: ConflictRecord): Row {
    return {
      id: c.conflict_id,
      entity_ref: c.entity_ref,
      local_event_id: c.local_event_id,
      remote_event_ids_json: JSON.stringify(c.remote_event_ids),
      assertion_a: c.assertion_a,
      assertion_b: c.assertion_b,
      provenance_a_json: JSON.stringify(c.provenance_a),
      provenance_b_json: JSON.stringify(c.provenance_b),
      device_a: c.device_a,
      device_b: c.device_b,
      detected_at: c.detected_at,
      status: c.status,
      resolution: c.resolution,
      resolved_at: c.resolved_at,
      resolution_event_id: c.resolution_event_id
    };
  }

  listConflicts(status?: 'UNRESOLVED' | 'RESOLVED'): ConflictRecord[] {
    return this.syncTables
      .query('conflicts', (r) => !status || r['status'] === status)
      .map((r) => this.rowToConflict(r))
      .sort((a, b) => a.detected_at - b.detected_at);
  }

  getConflict(id: string): ConflictRecord {
    const r = this.syncTables.get('conflicts', id);
    if (!r) throw new SyncError('UNKNOWN_CONFLICT', id);
    return this.rowToConflict(r);
  }

  private rowToConflict(r: Row): ConflictRecord {
    return {
      conflict_id: String(r['id']),
      entity_ref: String(r['entity_ref']),
      local_event_id: (r['local_event_id'] as string | null) ?? null,
      remote_event_ids: JSON.parse(String(r['remote_event_ids_json'])) as string[],
      assertion_a: String(r['assertion_a']),
      assertion_b: String(r['assertion_b']),
      provenance_a: JSON.parse(String(r['provenance_a_json'])) as string[],
      provenance_b: JSON.parse(String(r['provenance_b_json'])) as string[],
      device_a: String(r['device_a']),
      device_b: String(r['device_b']),
      detected_at: Number(r['detected_at']),
      status: r['status'] as ConflictRecord['status'],
      resolution: (r['resolution'] as ResolutionAction | null) ?? null,
      resolved_at: r['resolved_at'] == null ? null : Number(r['resolved_at']),
      resolution_event_id: (r['resolution_event_id'] as string | null) ?? null
    };
  }

  resolveConflict(conflictId: string, action: ResolutionAction, actor: string, extra: { data?: Record<string, unknown> } = {}): ConflictRecord {
    if (action === 'UNRESOLVED') throw new SyncError('INVALID_ACTION', 'UNRESOLVED is not a resolution action');
    const c = this.getConflict(conflictId);
    if (c.status === 'RESOLVED') throw new SyncError('ALREADY_RESOLVED', conflictId);
    const now = this.clock();
    if (action === 'ACCEPT_B' || action === 'KEEP_BOTH') {
      const events: KnowledgeEvent[] = [];
      for (const rid of c.remote_event_ids) {
        const d = this.syncTables.get('deferred_events', rid);
        if (!d) throw new SyncError('DEFERRED_LOST', rid);
        events.push(JSON.parse(String(d['event_json'])) as KnowledgeEvent);
      }
      this.knowledge.replay(events);
    } else if (action === 'MERGE') {
      if (c.entity_ref.startsWith('edge:') || !extra.data) {
        throw new SyncError('INVALID_MERGE', 'MERGE needs a node entity_ref and combined data');
      }
      const local = this.knowledge.getEntity(c.entity_ref);
      this.knowledge.proposeValidateCommit({
        assertion: 'OBSERVATION',
        ops: [{ op: 'upsert-node', node: { id: c.entity_ref, kind: local?.kind ?? 'Observation', label: local?.label ?? c.entity_ref, data: extra.data } }],
        provenance: {
          source: 'conflict-resolution', source_type: 'agent', source_identifier: `resolver:${actor}:${conflictId}`,
          observed_at: now, agent: actor, evidence_refs: [c.local_event_id, ...c.remote_event_ids].filter((x): x is string => !!x), confidence: 1
        },
        actor
      });
    }
    // Every resolution is recorded as a new knowledge event; originals untouched.
    const { event } = this.knowledge.proposeValidateCommit({
      assertion: 'OBSERVATION',
      ops: [{ op: 'upsert-node', node: { id: `conflict:${conflictId}`, kind: 'Observation', label: `resolution ${conflictId}`, data: { conflict_id: conflictId, entity_ref: c.entity_ref, action, resolved_at: now, actor } } }],
      provenance: {
        source: 'conflict-resolution', source_type: 'agent', source_identifier: `resolver:${actor}:${conflictId}`,
        observed_at: now, agent: actor, evidence_refs: [c.local_event_id, ...c.remote_event_ids].filter((x): x is string => !!x), confidence: 1
      },
      actor
    });
    this.syncTables.update('conflicts', conflictId, { status: 'RESOLVED', resolution: action, resolved_at: now, resolution_event_id: event.id });
    this.audit('conflict.resolved', { conflictId, action });
    return this.getConflict(conflictId);
  }

  // -- checkpoints / rollback ---------------------------------------------------

  checkpoint(): { knowledge: unknown; sync: unknown } {
    const t = this.tables as unknown as { snapshot?: () => unknown };
    if (typeof t.snapshot !== 'function') {
      throw new SyncError('CHECKPOINT_UNSUPPORTED', 'knowledge tables are not checkpointable (SQLite production path uses VACUUM INTO backups)');
    }
    return { knowledge: t.snapshot(), sync: this.syncTables.snapshot() };
  }

  rollback(cp: { knowledge: unknown; sync: unknown }): void {
    const t = this.tables as unknown as { restore?: (s: unknown) => void };
    if (typeof t.restore !== 'function') {
      throw new SyncError('CHECKPOINT_UNSUPPORTED', 'knowledge tables are not checkpointable');
    }
    t.restore(cp.knowledge);
    this.syncTables.restore(cp.sync as Map<string, Map<string, Row>>);
  }

  // -- audit --------------------------------------------------------------------

  private audit(event: string, fields: Record<string, unknown> = {}): void {
    this.logger.info(event, fields);
  }
}
