// Phase 7 proof on real SQLite (plain node, not vitest).
// §42 loop: research→strategy→signal→candidates→allocation→construction→risk→
// rebalance→state→memory→knowledge. §43 impossibility proofs. §44 rerun identity.
// Run: `pnpm build && node scripts/verify-portfolio.mjs`
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { KNOWLEDGE_DDL } from '../dist/packages/db-bootstrap/src/index.js';
import { KnowledgeStore } from '../dist/apps/knowledge-service/src/store.js';
import { SqliteTables } from '../dist/apps/knowledge-service/src/sqlite.js';
import { MemoryManager } from '../dist/apps/memory-manager/src/index.js';
import {
  evaluatePortfolioRisk, drawdownState, PHASE1_DEFAULTS,
  allocateHybrid, ALLOCATORS
} from '../dist/packages/portfolio/src/index.js';
import { PortfolioService } from '../dist/apps/portfolio-service/src/index.js';

let tick = 4_000_000_000_000;
const now = () => tick;

const db = new DatabaseSync(':memory:');
db.exec(KNOWLEDGE_DDL);
const tables = new SqliteTables(db);
const store = new KnowledgeStore(tables, { deviceId: 'dev-proof', now });
const memory = new MemoryManager(store);
const service = new PortfolioService(store, memory);
const results = {};
function check(name, cond, extra = '') {
  if (!cond) throw new Error(`PORTFOLIO PROOF FAILED: ${name} ${extra}`);
  results[name] = 'ok';
  console.log(`ok - ${name}`);
}

function cand(id, sector = 'Banks') {
  return {
    candidate_id: `cand-${id}`,
    instrument: { instrument_id: id, exchange: 'NSE', market: 'equity', segment: 'EQ', symbol: id },
    strategy_id: 'proof:roc', strategy_version: 1, signal_type: 'LONG',
    signal_strength: 0.8, signal_confidence: 0.7, expected_horizon_bars: 5,
    evidence_refs: ['ev-proof'], regime: 'up_low',
    liquidity: { adv_value: 500_000_000, spread_bps: 5, volume: 2_000_000 },
    direction: 1, reference_price: 100, invalidation: [`instrument:${id}`]
  };
}

function market(ids) {
  const m = { prices: {}, volumes: {}, adv: {}, spreads_bps: {}, volatilities: {}, sectors: {}, quality: {} };
  for (const id of ids) {
    m.prices[id] = 100; m.volumes[id] = 2_000_000; m.adv[id] = 500_000_000;
    m.spreads_bps[id] = 5; m.volatilities[id] = 0.2; m.sectors[id] = 'Banks';
    for (const k of ['price', 'adv', 'spread', 'sector', 'vol']) m.quality[`${k}:${id}`] = 'VALID';
  }
  m.as_of = tick;
  return m;
}

function req(ids, over = {}) {
  return {
    portfolio_id: 'proof-port', candidates: ids.map((id) => cand(id)), market: market(ids),
    current: [], capital: { total: 1_000_000, reserved_pct: 0, base_currency: 'INR' },
    peak_equity: 1_000_000, prev_equity: 1_000_000, actor: 'proof', trace_id: 'proof-1', now: tick, ...over
  };
}

// Full loop: research-shaped candidates → allocation → risk → rebalance → memory/knowledge.
const r1 = service.construct(req(['P1', 'P2', 'P3']));
check('loop-completes', r1.flow === 'COMPLETED' || r1.flow === 'PARTIAL');
check('within-caps', r1.decision.exposure.gross_pct <= 60 && r1.target_positions.every((p) => p.weight_pct <= 2.01));
check('risk-final', r1.decision.risk_decisions.length > 0);
check('persisted', !!store.getEntity(`portfolio-decision:${r1.decision.decision_id}`));
check('methods-present', Object.keys(ALLOCATORS).length === 6);
const hybrid = allocateHybrid([cand('H1'), cand('H2')], { volatilities: { H1: 0.2, H2: 0.4 } }, 100);
check('hybrid-bounded', Object.values(hybrid.weights).every((w) => w <= 100));

// NO_TRADE is success.
const empty = service.construct(req([]));
check('no-trade', empty.flow === 'NO_TRADE' && empty.decision.outcome === 'NO_TRADE');

// Risk veto: oversized book reduced; halted state blocks.
const big = service.construct(req(['P1'], { drawdown_override: 9 }));
check('halt-blocks', big.decision.outcome === 'RISK_BLOCKED' && big.target_positions.length === 0);
check('drawdown-states', drawdownState(1, 0, PHASE1_DEFAULTS) === 'NORMAL' && drawdownState(9, 0, PHASE1_DEFAULTS) === 'HALTED');

// §44 reproducibility: identical rerun, identical decision, no duplicate knowledge.
const kvBefore = store.knowledgeVersion();
const r2 = service.construct(req(['P1', 'P2', 'P3']));
check('reproducible', r2.decision.decision_id === r1.decision.decision_id && JSON.stringify(r2.decision) === JSON.stringify(r1.decision));
check('idempotent-persist', store.knowledgeVersion() === kvBefore);

// §43 impossibility proofs.
const walk = (dir, out = []) => {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${f.name}`;
    if (f.isDirectory()) walk(p, out);
    else if (f.name.endsWith('.ts') && !f.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
};
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.split('//')[0]).join('\n');
const bad = [];
for (const f of [...walk('packages/portfolio/src'), ...walk('apps/portfolio-service/src')]) {
  const src = strip(readFileSync(f, 'utf8'));
  if (/\bplaceOrder\b|BrokerPort|kiteconnect|\bexecSync\b|new Function\s*\(|\beval\s*\(/.test(src)) bad.push(f);
  if (/@aurix\/broker-sim|@aurix\/broker-kite|@aurix\/execution-service|@aurix\/model-gateway|ml-training|child_process/.test(src)) bad.push(`${f}::import`);
}
check('proof1-no-portfolio-broker', bad.length === 0, bad.join(','));
check('proof2-no-portfolio-execution', bad.length === 0);
check('proof3-no-llm-risk-override', !strip(readFileSync('packages/portfolio/src/risk.ts', 'utf8')).includes('model-gateway'));
const llmFree = !strip(readFileSync('packages/portfolio/src/allocation.ts', 'utf8')).includes('interpreter');
check('proof4-no-llm-weights', llmFree);
const unk = evaluatePortfolioRisk({
  portfolio_id: 'p', candidates: [], current: { gross_pct: 0, sector_pct: {}, top5_pct: 0, leverage: 1, margin_pct: 0, daily_loss_pct: 0, drawdown_pct: 99 },
  market: { abnormal: false, haltedIds: [] }, quality: {}, trace_id: 't'
}, PHASE1_DEFAULTS, tick);
check('proof5-unknown-never-allow', unk.portfolioVerdict === 'REJECT');
check('proof6-reject-never-approved', big.decision.approved && Object.keys(big.decision.approved).length === 0);

console.log(`\nPORTFOLIO PROOF: ${Object.keys(results).length} checks ok (kv=${store.knowledgeVersion()})`);
db.close();
