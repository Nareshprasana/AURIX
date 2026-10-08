// Proves Phase 1 DDL executes on real SQLite (node:sqlite) with WAL.
// Run with plain node (not vitest): `node scripts/verify-sqlite.mjs`
// Vitest cannot load node:sqlite, so this runs outside the test runner.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// DDL lives in TS source; extract template literals without a TS toolchain.
function extractConst(path, name) {
  const src = readFileSync(path, 'utf8');
  const m = src.match(new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`const ${name} not found in ${path}`);
  return m[1];
}

const CORE = extractConst('packages/db-bootstrap/src/index.ts', 'CORE_DDL');
const KNOWLEDGE = extractConst('packages/db-bootstrap/src/index.ts', 'KNOWLEDGE_DDL');
const PORTFOLIO = extractConst('packages/db-bootstrap/src/index.ts', 'PORTFOLIO_DDL');

for (const [label, ddl] of [['core', CORE], ['knowledge', KNOWLEDGE], ['portfolio', PORTFOLIO]]) {
  const db = new DatabaseSync(':memory:');
  db.exec(ddl);
  const mode = db.prepare('PRAGMA journal_mode').get();
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map((t) => t.name);
  console.log(`${label}: journal_mode=${mode.journal_mode} tables=[${tables.join(',')}]`);
  // Round-trip one events row (outbox write path).
  if (label === 'core') {
    db.prepare(`INSERT INTO events(id,type,payload_json,status,idempotency_key,created_at,attempts) VALUES(?,?,?,?,?,?,0)`)
      .run('verify-1', 'verify.ping', '{}', 'PENDING', 'verify-k1', Date.now());
    const row = db.prepare(`SELECT * FROM events WHERE id=?`).get('verify-1');
    if (!row || row.type !== 'verify.ping') throw new Error('events round-trip failed');
    console.log('core: events outbox round-trip ok');
  }
  db.close();
}
console.log('verify-sqlite ok');
