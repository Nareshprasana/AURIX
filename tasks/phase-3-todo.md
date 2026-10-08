# AURIX Phase 3 TODO

From `tasks/phase-3-plan.md`. Phase 1 (83 TS + 2 py) and Phase 2 suites must stay green.

## Design
- [x] `tasks/phase-3-plan.md` (§1–§26)
- [x] `tasks/phase-3-todo.md` (this file)

## Protocol types (`packages/sync-protocol`, zero node imports)
- [x] DeviceIdentity, StoreIdentity, SyncEnvelope, VersionVector, SyncManifest
- [x] Transfer envelope, ConflictRecord, ResolutionAction, TrustEntry, audit records
- [x] Merge/dry-run report types, compat verdicts, transport interface
- [x] Tests: filename validation, compat majors, vector triage

## Sync DB (`packages/db-bootstrap`)
- [x] SYNC_DDL: event_sync, sync_state, trusted_devices, conflicts, deferred_events, import_log
- [x] DDL assertion tests

## Engine (`apps/sync-manager`)
- [x] Identity: ensureIdentity (stable, no host facts) + keypairs
- [x] Store identity: ensureStoreId (independent of device)
- [x] Envelopes: assignEnvelopes backfill + version vectors
- [x] Crypto: x25519+HKDF+AES-GCM encrypt, Ed25519 sign/verify (node:crypto only)
- [x] Packages: create (immutable, minimal state) + envelope-file read/write + filename validation
- [x] Discovery: scanIncoming + inspectPackage (verify order: manifest→signature→decrypt→checksum→schema), no mutation
- [x] Dry-run: full report, zero mutations (snapshot-identical assert)
- [x] Divergence: A/B/C triage via vectors + entity comparison
- [x] Conflicts: classification (8 classes), records, deferral (no destructive apply)
- [x] Merge: AUTO_MERGE/CONFLICT/REJECT; resolution interface (6 actions) via knowledge events
- [x] Idempotency: package/event/multi-path (tests)
- [x] Checkpoints: MemoryTables + SqliteTables snapshot/restore; VACUUM INTO file path; resume + rollback tests
- [x] Trust: registry, default REJECT, explicit add, PENDING_TRUST quarantine option
- [x] Schema compat: compatible/upgrade-required/unsupported
- [x] Audit JSONL (redacted, correlation ids)
- [x] Transports: LocalFilesystemTransport + SyncthingTransport (layout validation, .stignore gen, no .db* ever)
- [x] MemoryTables.snapshot()/restore()

## Verification scripts
- [x] `scripts/verify-sync-sqlite.mjs` (real-SQLite two-device transfer + VACUUM checkpoint)

## Tests (two-device fixtures, no daemon)
- [x] Basic A→B, reverse, duplicate, behind fast-forward, divergence, contradiction + 6 resolutions
- [x] Evidence preserved, interrupt/resume, rollback identical, tamper matrix, trust matrix, schema matrix
- [x] Security: secrets, path traversal, executable payload, wrong key
- [x] Idempotency trio; integration outgoing→incoming; no-db-in-sync-dirs; identity stability

## Audit + verify + commit
- [x] `pnpm test`, `pytest`, `typecheck`, `lint`, all three sqlite scripts
- [x] `docs/audits/phase-3-audit.md` (12 verification points, severity classification)
- [x] Focused commits; final report (no Phase 4)
