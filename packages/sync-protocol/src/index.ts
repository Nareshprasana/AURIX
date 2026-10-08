// @aurix/sync-protocol — pure types + deterministic helpers for knowledge sync.
// Zero node imports (safe for any runtime). Crypto/IO live in apps/sync-manager.

export interface DeviceIdentity {
  device_id: string;
  installation_id: string;
  created_at: number;
  identity_version: 1;
}

export interface DeviceKeyPair {
  device_id: string;
  ed25519_public: string;
  ed25519_private: string;
  x25519_public: string;
  x25519_private: string;
}

export interface StoreIdentity {
  knowledge_store_id: string;
  knowledge_schema_version: string;
  knowledge_state_version: number;
}

export interface SyncEnvelope {
  event_id: string;
  origin_device: string;
  origin_seq: number;
  parents: string[];
  created_at: number;
}

/** Per-origin high-water marks. Never treat higher local kv as globally newer. */
export type VersionVector = Record<string, number>;

export interface OriginRange {
  origin_device: string;
  from_seq: number;
  to_seq: number;
  count: number;
}

export type SchemaCompat = 'COMPATIBLE' | 'UPGRADE_REQUIRED' | 'UNSUPPORTED';

export interface SyncManifest {
  package_id: string;
  sender_device_id: string;
  sender_installation_id: string;
  knowledge_store_id: string;
  schema_version: string;
  event_schema_version: string;
  package_version: string;
  created_at: number;
  knowledge_state_version: number;
  version_vector: VersionVector;
  ranges: OriginRange[];
  event_count: number;
  content_hash: string;
  package_hash: string;
  crypto: { version: 'gcm-ed25519-v1'; iv: string; ephemeral_pub: string; tag: string };
  signature: string;
}

export interface TransferFile {
  manifest: SyncManifest;
  encrypted: string;
  ephemeral_pub: string;
}

export type ConflictClass =
  | 'IDENTICAL'
  | 'DUPLICATE'
  | 'NON_CONFLICTING'
  | 'CONCURRENT'
  | 'CONTRADICTORY'
  | 'SCHEMA_CONFLICT'
  | 'TRUST_CONFLICT'
  | 'VERSION_CONFLICT';

export type ResolutionAction = 'UNRESOLVED' | 'ACCEPT_A' | 'ACCEPT_B' | 'MERGE' | 'KEEP_BOTH' | 'REJECT_BOTH';

export interface ConflictRecord {
  conflict_id: string;
  entity_ref: string;
  local_event_id: string | null;
  remote_event_ids: string[];
  assertion_a: string;
  assertion_b: string;
  provenance_a: string[];
  provenance_b: string[];
  device_a: string;
  device_b: string;
  detected_at: number;
  status: 'UNRESOLVED' | 'RESOLVED';
  resolution: ResolutionAction | null;
  resolved_at: number | null;
  resolution_event_id: string | null;
}

export interface TrustEntry {
  device_id: string;
  installation_id: string;
  ed25519_public: string;
  x25519_public: string;
  added_at: number;
  status: 'ACTIVE' | 'REVOKED';
}

export type MergeOutcome = 'AUTO_MERGE' | 'CONFLICT' | 'REJECT';

export interface DryRunReport {
  newEvents: string[];
  duplicateEvents: string[];
  newEntities: string[];
  newRelationships: string[];
  updatedEntities: string[];
  expiredRelationships: string[];
  conflicts: ConflictRecord[];
  schemaDiff: { sender: string; local: string; verdict: SchemaCompat };
  unsupportedEvents: string[];
  securityFailures: string[];
  triage: 'BEHIND' | 'DIVERGED' | 'AHEAD' | 'IN_SYNC';
}

export interface SyncAuditRecord {
  ts: number;
  event: string;
  package_id: string | null;
  device_id: string | null;
  correlation_id: string;
  result: string;
  reason: string | null;
}

export interface KnowledgeTransferTransport {
  readonly kind: string;
  root(): string;
  outgoingDir(): string;
  incomingDir(): string;
  processedDir(): string;
  rejectedDir(): string;
  stageOutgoing(packageId: string, content: string): string;
  listIncoming(): string[];
  readIncoming(name: string): string;
  markProcessed(name: string): void;
  markRejected(name: string): void;
}

// -- pure helpers (deterministic, testable without node) --------------------

export const PACKAGE_SUFFIX = '.akpkg.json';
const PACKAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.akpkg\.json$/;

export function isValidPackageName(name: string): boolean {
  if (!PACKAGE_NAME_RE.test(name)) return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  return true;
}

export function majorOf(version: string): number {
  const m = /-v(\d+)(?:\.|$)/.exec(version);
  return m ? Number(m[1]) : 0;
}

/** equal major → COMPATIBLE; sender older → UPGRADE_REQUIRED; sender newer → UNSUPPORTED. */
export function checkSchemaCompat(senderSchema: string, localSchema: string): SchemaCompat {
  const s = majorOf(senderSchema);
  const l = majorOf(localSchema);
  if (s === l && s !== 0) return 'COMPATIBLE';
  if (s !== 0 && l !== 0 && s < l) return 'UPGRADE_REQUIRED';
  return 'UNSUPPORTED';
}

/** Triage from version vectors: BEHIND (fast-forwardable), DIVERGED, AHEAD, IN_SYNC. */
export function triageVectors(local: VersionVector, remote: VersionVector): 'BEHIND' | 'DIVERGED' | 'AHEAD' | 'IN_SYNC' {
  const devices = new Set([...Object.keys(local), ...Object.keys(remote)]);
  let remoteAhead = false;
  let localAhead = false;
  for (const d of devices) {
    const l = local[d] ?? 0;
    const r = remote[d] ?? 0;
    if (r > l) remoteAhead = true;
    if (l > r) localAhead = true;
  }
  if (remoteAhead && !localAhead) return 'BEHIND';
  if (localAhead && !remoteAhead) return 'AHEAD';
  if (!remoteAhead && !localAhead) return 'IN_SYNC';
  return 'DIVERGED';
}
