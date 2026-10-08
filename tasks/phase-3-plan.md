# AURIX Phase 3 Plan — Knowledge Transfer, Syncthing & Conflict Resolution

Baseline: Phase 1 `b593a49`+`5746c9b`, Phase 2 `7a62677`+`503cd85` (PASS). No Phase 1/2
rewrite; additive only. No market-data/research/strategy/broker/training/live work.

Principle: **Syncthing transports. AURIX understands.** Sync semantics, validation,
conflict detection and merging live in AURIX; the transport moves opaque immutable files.
Live SQLite (`*.db*`) is NEVER synchronized — only immutable transfer artifacts.

## 1. New packages (additive, existing model untouched)

- `packages/sync-protocol` — pure types, zero node imports: DeviceIdentity, StoreIdentity,
  SyncEnvelope, VersionVector, SyncManifest, TransferPackage envelope, ConflictRecord,
  ResolutionAction/Record, TrustEntry, SyncAuditRecord, MergeReport/DryRunReport,
  KnowledgeTransferTransport interface, schema-compat verdicts.
- `apps/sync-manager` — deterministic engine (node:crypto + node:fs only):
  identity, crypto, packages, discovery, verify, dry-run, divergence/conflict analysis,
  transactional merge, checkpoints/rollback, trust registry, audit log, transports.

## 2. Device identity

`DeviceIdentity { device_id, installation_id, created_at, identity_version: 1 }`.
`ensureIdentity(dir)`: load `identity.json` or generate once (`dev-<128-bit hex>` from
`randomBytes`), persist, stable across restarts. Never hostname/IP/MAC/username (documented
+ test asserts generated ids carry no host facts). Keypair (ed25519 sign + x25519 ECDH)
generated alongside, stored in `keys/` (0600-style, gitignored, never in packages).

## 3. Knowledge-store identity

`StoreIdentity { knowledge_store_id, knowledge_schema_version, knowledge_state_version }`.
`knowledge_store_id` (`ks-<hex>`) persisted in sync.db, independent of device: reinstall or
clone yields a NEW store id (test). System distinguishes same-device/same-store vs
different-store; packages bind to origin store id; a package is never assumed to belong to
the receiver's store.

## 4. Global event identity (compatible with Phase 2 schema)

Phase 2 event ids (`ke-<localSeq>-<hash>`) are content-stable but locally sequenced — two
devices can mint the same `kv-N` for different content. Sync adds a side table
`event_sync(event_id PK, origin_device, origin_seq, parents_json, created_at)`; the event
id itself remains the global content identity. `SyncManager.assignEnvelopes()` backfills
local commits (device_id match, no envelope) in (created_at,id) order, chaining parents to
the previous local tip; incoming applied events keep sender envelopes. No Phase 2 rewrite.

## 5. Event causality (lightweight, no consensus)

Envelope parents = local tip(s) known at creation ⇒ causal order vs concurrency is
decidable: event X precedes Y iff X ∈ ancestry(Y). Version vectors `{device: maxOriginSeq}`
ride in manifests for Case-A/B triage. Rule: never treat higher local kv as globally newer.

## 6. Sync manifest (verifiable before import)

`SyncManifest { package_id, sender_device_id, sender_installation_id,
knowledge_store_id, schema_version, event_schema_version, package_version, created_at,
knowledge_state_version, version_vector, ranges: [{origin_device, from_seq, to_seq, count}],
event_count, content_hash, package_hash, crypto: {version: 'gcm-ed25519-v1', …},
signature }`. Receiver verifies manifest → signature → decrypt → checksums → schema, in
that order, before touching the knowledge DB.

## 7. Immutable transfer packages (`sync/{outgoing,incoming,processed,rejected}`)

`createPackage({events, store})`: select events (default: all unknown-to-peer per vv, else
explicit range) + minimal reconstructive state (Phase 2 export sections for those events'
entities: snapshot subset, provenance, memories, embeddings) + envelopes + manifest.
Filename `<package_id>.akpkg.json` (validated `^[A-Za-z0-ev9_-]+\.akpkg\.json$`); never
overwritten. Rejected/processed dirs for lifecycle; `*.db*` never written under sync roots
(enforced + tested).

## 8. Encryption (standard primitives only, no custom crypto)

Deviation documented: architecture §15 names age/XChaCha as the target; no age code exists,
so Phase 3 uses a versioned standard-library envelope (`gcm-ed25519-v1`): X25519 ECDH
(ephemeral sender → recipient trust key) → HKDF-SHA256 → AES-256-GCM file encryption;
Ed25519 signs manifest+content hash. Keys never in packages; secrets scan pre-encryption;
wrong-key decryption fails closed (GCM auth tag). Age migration stays explicit via
`crypto.version`.

## 9. Authentication / signing

Receiver rejects: bad signature, unknown/untrusted device (default REJECT; PENDING_TRUST
only if explicitly configured — never auto-applies), tampered bytes, manifest mismatch,
checksum mismatch, schema incompatibility. Trust registry `trusted_devices(device_id,
ed25519_pub, x25519_pub, added_at, status)`; no remote administration in Phase 3.

## 10. Transports

`KnowledgeTransferTransport` interface (listOutgoing, deliverToIncoming, scanIncoming,
markProcessed/markRejected). `LocalFilesystemTransport` (real moves/copies; used by all
unit tests) + `SyncthingTransport(root)` (folder-integration point: validates the four-dir
layout, generates `.stignore` rules blocking `*.db*`, logs, models, envs; NEVER reads
Syncthing internals). Future USB/LAN/cloud transports plug the same interface without
touching merge logic. Integration test: A.outgoing → (copy) → B.incoming → detect →
verify → dry-run → merge, no daemon.

## 11. Discovery (no mutation)

`scanIncoming()` → envelope files → `inspectPackage()` (manifest/signature/checksum/schema)
→ report. DB untouched until an explicit import call.

## 12. Dry-run (no mutations, full report)

`dryRun(pkg)` returns `{ newEvents, duplicateEvents, newEntities, newRelationships,
updatedEntities, expiredRelationships, conflicts[], schemaDiff, unsupportedEvents[],
securityFailures[] }`, computed by comparing incoming events+state against local queries.
Asserts in tests that store snapshots are byte-identical before/after dry-run.

## 13. Divergence detection (Cases A/B/C distinct)

From version vectors + entity comparison: A (receiver behind — all incoming parents known,
no local unknowns) → fast-forward eligible; B (both sides have unknowns) → divergent,
per-event classification; C (same entity, different canonical content) → contradictory.
Never conflated; dry-run labels each event with its case.

## 14. Conflict detection & classification

Per-event: IDENTICAL (same id+content known) / DUPLICATE (same id) / NON_CONFLICTING
(new entity/edge/memory, disjoint) / CONCURRENT (diverged but disjoint entities) /
CONTRADICTORY (same entity, different content; same edge triple, different data) /
SCHEMA_CONFLICT / TRUST_CONFLICT / VERSION_CONFLICT (gaps in origin_seq ranges).
`ConflictRecord { conflict_id, entity_ref, local_event_id, remote_event_id, assertion
summaries, provenance refs, devices, detected_at, status, resolution? }` persisted in
sync.db; both evidence chains preserved (remote event stored deferred, never dropped).

## 15. Financial conflict policy (no timestamp-wins)

CONTRADICTORY entity updates are NEVER auto-merged: remote event deferred as UNRESOLVED,
local state untouched. Deterministic order is used only for *reporting*, never for
choosing truth. Uncertainty preserved by construction.

## 16. Safe merge (AUTO_MERGE / CONFLICT / REJECT)

Only NON_CONFLICTING/CONCURRENT/IDENTICAL/DUPLICATE (no-op) outcomes auto-apply (via the
idempotent `KnowledgeStore.replay` path). Anything else → CONFLICT (defer + record) or
REJECT (trust/schema/security/incomplete-range, package to `rejected/`).

## 17. Conflict resolution interface

`resolveConflict(id, action: UNRESOLVED|ACCEPT_A|ACCEPT_B|MERGE|KEEP_BOTH|REJECT_BOTH,
actor, payload?)`: ACCEPT_A keeps local (remote stays deferred+recorded); ACCEPT_B applies
remote now; KEEP_BOTH applies remote as a new version (history shows both);
MERGE commits caller-supplied combined content as a new version referencing both;
REJECT_BOTH records rejection, applies nothing. Every resolution commits a resolution
knowledge event (`conflict:<id>` OBSERVATION via the normal propose/validate/commit path);
originals never rewritten. Resolution of already-resolved → error (no double-apply).

## 18. Idempotency

Same package twice → second import 0 mutations (event ids known; tested). Same event via
different packages → skipped as DUPLICATE (tested). Package filename reuse → refused
(immutable packages; tested).

## 19. Interrupted import & rollback

Merge = checkpoint → dry-run → validate → apply-with-import-log → commit-point.
Crash simulation (injectable throw mid-apply): restart resumes via idempotent replay
(applied events skipped, remainder applied — tested). Checkpoint/rollback primitives:
MemoryTables gains snapshot/restore; SQLite path uses `VACUUM INTO` backup + file restore
(proven in the new verify script with temp files). Rollback restores pre-merge snapshot
byte-identical (tested). Event history itself is never deleted.

## 20. Schema compatibility

Manifest declares all three versions. Receiver: equal major → compatible; sender older
major → UPGRADE_REQUIRED (importable, flagged — old fields are a subset); sender newer →
UNSUPPORTED → reject. Never silently interpret. All three tested.

## 21. Device trust

Default REJECT unknown devices (configurable PENDING_TRUST quarantine that still applies
nothing). Trust additions are local-only explicit calls. All trust decisions audited.

## 22. Security (fail-closed importer)

Tampered bytes/signature/manifest/event, wrong key, checksum mismatch, malformed JSON,
path-traversal filenames, unexpected files ignored, secret-bearing packages rejected
pre-decrypt scan + knowledge-layer scan double gate, packages treated as inert DATA
(parsed JSON only, never executed/eval'd, no file extraction). Each tested.

## 23. Audit logging

JSONL via observability `createLogger` (redacted): discovered/verify/dry-run/conflicts/
merge/reject with package_id, device ids, correlation_id, timestamps, result+reason.
No keys/secrets logged (tested by scanning audit output).

## 24. Tests (all deterministic, no Syncthing daemon)

Two-device fixtures (tmp dirs + LocalFilesystemTransport): A→B, B→A, duplicate transfer,
behind-receiver fast-forward, divergence, contradictory conflict + all six resolutions,
conflicting evidence preserved, interrupted-import resume, rollback byte-identical,
tamper/signature/key/manifest/checksum/schema/trust matrix, secret/path-traversal/
executable-payload rejection, idempotency (package/event/multi-path), integration
A.outgoing→B.incoming end-to-end, db-files-never-in-sync-dirs, identity stability.

## 25. Non-goals / constraints

No Kafka/NATS/Redis/Postgres/Neo4j/K8s/cloud backends, no consensus protocol, no remote
admin, no market-data/research/strategy/broker/training/live work. Phase 1/2 suites must
stay green; no safety test deleted or weakened.

## 26. Verification gates

`pnpm test`, `pytest`, `pnpm typecheck`, `pnpm lint` (extend: sync-manager must not import
broker/execution/risk/research/training/model-gateway; transports must not import
knowledge-store internals beyond the public facade), both existing sqlite scripts,
new `node scripts/verify-sync-sqlite.mjs` (real-SQLite two-device transfer incl. VACUUM
checkpoint), then `docs/audits/phase-3-audit.md` (transport-only Syncthing, no-db-sync,
append-only, idempotency, divergence, conflict preservation, determinism, import safety,
auth, encryption, unknown-device, secrets).
