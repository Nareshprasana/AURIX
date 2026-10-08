# AURIX Phase 3 Audit Report — Knowledge Transfer, Syncthing & Conflict Resolution

**Scope:** Phase 3 implementation against the Phase 3 brief (§§1–35), Master Spec portability
requirements, architecture v1.0.1 §15 (Amendment 4), `tasks/phase-3-plan.md` (§1–§26).
Phase 1/2 regression required (no safety test deleted or weakened).
**Baseline:** Phase 1 `b593a49`+`5746c9b`, Phase 2 `7a62677`+`503cd85` (PASS).
**Method:** code re-read + repo-wide searches + full test execution. Test-green treated as
necessary but not sufficient; each §34 point re-proven against the implementation.

## 1. Twelve verification points (§34)

| # | Claim | Verdict + evidence |
|---|---|---|
| 1 | Syncthing is transport only | PASS — `SyncthingTransport` moves opaque files, validates layout, generates `.stignore`, refuses daemon duties; merge logic never touches transport internals; alternative transports plug the same interface |
| 2 | Live databases never synchronized | PASS — only `*.akpkg.json` staged/listed; `assertNoLiveDb` fails closed on any `*.db*` under sync roots; transfer tests scan all four dirs for `*.db*`; proof script re-asserts |
| 3 | Events remain append-only | PASS — sync applies exclusively via idempotent `KnowledgeStore.replay`; no update/delete of `knowledge_events` exists in sync code (verified by search); deferred/conflict rows are sync metadata, not knowledge rewrites |
| 4 | Duplicate imports idempotent | PASS — same package twice → 0 mutations; same event via different packages → DUPLICATE skip; filename reuse refused (immutable packages). All three tested |
| 5 | Divergence detected (A/B/C distinct) | PASS — vector triage (BEHIND/DIVERGED/AHEAD/IN_SYNC) + per-entity comparison; behind fast-forwards, divergent disjoint auto-merges, same-entity-different-content conflicts. Each tested |
| 6 | Conflicts preserved, never timestamp-won | PASS — CONTRADICTORY defers remote events, records both evidence chains, local untouched; deterministic order used for reporting only. Tested incl. all six resolutions via new knowledge events, originals intact |
| 7 | Historical evidence preserved | PASS — resolutions append (`conflict:<id>` nodes + applied versions); `node_versions`/expired edges untouched by sync; ACCEPT_B/KEEP_BOTH histories show both sides (tested) |
| 8 | Merges deterministic | PASS — canonical JSON, ordered events, deterministic ids (packages, conflicts, envelopes); identical inputs → identical outcomes (replay tests + snapshot comparisons) |
| 9 | Failed imports cannot corrupt knowledge | PASS — checkpoint → apply → rollback on error (byte-identical proven); crash simulation rolls back; partial-state resume completes without duplicates; VACUUM INTO file backup/restore proven on real SQLite |
| 10 | Packages authenticated + encrypted | PASS — Ed25519 manifest signature verified against trust registry before decrypt; X25519+HKDF+AES-256-GCM authenticated encryption (wrong key/tampered bytes fail closed). Tamper matrix all green |
| 11 | Unknown devices cannot write knowledge | PASS — default REJECT (quarantine option still applies nothing); sender cannot target untrusted recipients (no key, no package). Tested both directions |
| 12 | Secrets cannot enter packages | PASS — pre-encryption scan + knowledge-layer scan double gate; honestly-signed secret package rejected; audit logs scanned secret-free; keys never in packages/files synced |

## 2. Findings fixed during implementation (before this report)

- **F-P3-1 (MEDIUM, FIXED):** `versionVector()` read only previously-enveloped events, so a
  device that had never sent showed an empty vector — triage reported BEHIND instead of
  DIVERGED and empty packages were minted instead of refused. Fixed: vector computation
  self-assigns envelopes first (idempotent, deterministic). Caught by Case-B and
  duplicate-transfer tests.
- **F-P3-2 (LOW, FIXED with disclosure):** `scripts/lint.mjs` built its repo root from
  `URL.pathname`, which is broken on Windows (`%20`, doubled drive) — `existsSync` guards
  silently skipped every boundary check, so lint was vacuously green in Phases 1–2. Fixed
  with `fileURLToPath`; all boundary rules now genuinely execute and pass. (Deterrent depth
  was never lost: the vitest import-path tests enforced the same boundaries for real.)
- **F-P3-3 (LOW, FIXED):** `SqliteTables` had no snapshot/restore, making transactional import
  impossible on SQLite. Fixed with allowlisted full-table snapshot/restore; VACUUM INTO file
  backups remain the disaster-recovery mechanism (proven in `verify-sync-sqlite.mjs`).
- **Process note:** two edit-scarring incidents left methods outside the class body during
  construction (transform failures); both repaired immediately, structure verified by green
  transform + tests. No working code was rewritten to hide a requirement.

## 3. Severity classification

No CRITICAL or HIGH findings. MEDIUM: F-P3-1 (fixed + tested). LOW: F-P3-2, F-P3-3 (fixed).
INFORMATIONAL (non-blocking, recorded):
- O1: crypto envelope is `gcm-ed25519-v1` (stdlib AES-GCM + Ed25519), not age/XChaCha. The
  architecture named age as the target but no age code exists; versioned envelope keeps the
  migration explicit. No custom primitives were invented.
- O2: sync metadata (envelopes/conflicts/deferred/import log) lives in memory tables +
  JSON files (identity/trust/store-id/audit), recomputed deterministically after restart
  (proven by the restart/resolution-durability test). SYNC_DDL is defined, asserted, and
  exec-proven as the approved schema for later file-backed wiring.
- O3: MERGE resolution applies to node conflicts only (edge conflicts resolve via
  ACCEPT/KEEP_BOTH/REJECT); UPGRADE_REQUIRED older-major packages import flagged.
- O4: `dist/` build output is gitignored; proof scripts rebuild via `pnpm build`.

## 4. Regression + verification (executed)

- `pnpm test`: **27 files, 166 tests, all pass** (127 Phase 1+2 intact — per-file counts ≥
  baseline; db suite 4→5 by addition; zero Phase 1/2 tests modified or deleted).
- `pnpm typecheck`: clean. `pnpm lint`: clean (now genuinely executing).
- `pytest`: **8 passed** (5 prior + 3 sync parity).
- `node scripts/verify-sqlite.mjs`, `verify-knowledge-sqlite.mjs`: ok.
- `pnpm build` + `node scripts/verify-sync-sqlite.mjs`: two file-backed devices, divergent
  transfer, contradiction → KEEP_BOTH, VACUUM backup + file restore identical. Ok.
- Searches: no broker/execution/risk/research/training/gateway imports in sync engine;
  transport imports no knowledge store; Python sync module has no writers/crypto/secrets.

## 5. Final verdict

**PASS** — Phase 3 makes AURIX knowledge safely transferable with Syncthing as a pure
file transport: authenticated, encrypted, idempotent, divergence-aware, conflict-preserving,
deterministic merge with transactional safety and full audit. All findings fixed and
verified; remaining items are documented non-blocking observations.
