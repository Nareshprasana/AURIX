// @aurix/db-bootstrap — Phase 1 DDL for core/knowledge/portfolio SQLite files.
export const CORE_DDL = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS instruments(
  id TEXT PRIMARY KEY, exchange TEXT NOT NULL, market TEXT NOT NULL,
  segment TEXT NOT NULL, symbol TEXT NOT NULL, isin TEXT,
  lot_size REAL NOT NULL, tick_size REAL NOT NULL,
  contract_json TEXT, meta_json TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS eligibility(
  instrument_id TEXT PRIMARY KEY, state TEXT NOT NULL,
  reason TEXT NOT NULL, source TEXT NOT NULL, as_of INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS regulatory_rules(
  id TEXT PRIMARY KEY, authority TEXT NOT NULL, topic TEXT NOT NULL,
  summary TEXT NOT NULL, source_url TEXT, effective_from TEXT, payload_json TEXT);
CREATE TABLE IF NOT EXISTS market_status(
  exchange TEXT NOT NULL, market TEXT NOT NULL, segment TEXT NOT NULL,
  status TEXT NOT NULL, as_of INTEGER NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY(exchange, market, segment));
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL, claimed_by TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT);
CREATE TABLE IF NOT EXISTS workflows(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, state_json TEXT NOT NULL,
  status TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS modes(
  id INTEGER PRIMARY KEY CHECK(id=1), current TEXT NOT NULL,
  history_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS promotions(
  promotion_id TEXT PRIMARY KEY, system_version TEXT NOT NULL,
  risk_policy_version TEXT NOT NULL, model_version TEXT NOT NULL,
  strategy_versions_json TEXT NOT NULL, validation_results_ref TEXT NOT NULL,
  paper_trading_results_ref TEXT NOT NULL, approval_timestamp TEXT,
  operator_identity TEXT, state TEXT NOT NULL);
`;

export const KNOWLEDGE_DDL = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS nodes(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL,
  data_json TEXT NOT NULL, label_class TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, version TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS edges(
  id TEXT PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL, rel TEXT NOT NULL,
  data_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge_events(
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, entity_ref TEXT NOT NULL,
  payload_json TEXT NOT NULL, actor TEXT NOT NULL, label_class TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL, prev_version TEXT NOT NULL,
  new_version TEXT NOT NULL, device_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS provenance(
  id TEXT PRIMARY KEY, entity_ref TEXT NOT NULL, what TEXT NOT NULL,
  when_ts INTEGER NOT NULL, source TEXT NOT NULL, agent TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL, confidence REAL, validated INTEGER NOT NULL DEFAULT 0,
  outcome_ref TEXT);
CREATE TABLE IF NOT EXISTS memories(
  id TEXT PRIMARY KEY, category TEXT NOT NULL, key TEXT NOT NULL,
  content_json TEXT NOT NULL, embedding_ref TEXT, regime TEXT,
  strategy_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS versions(
  component TEXT PRIMARY KEY, version TEXT NOT NULL,
  checksum TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

export const PORTFOLIO_DDL = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS decisions(
  decision_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, instrument_id TEXT NOT NULL,
  side TEXT NOT NULL, qty REAL NOT NULL, order_type TEXT NOT NULL,
  limit_price REAL, status TEXT NOT NULL, broker_order_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fills(
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, qty REAL NOT NULL,
  price REAL NOT NULL, fees REAL NOT NULL DEFAULT 0,
  slippage_bps REAL NOT NULL DEFAULT 0, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS positions(
  instrument_id TEXT PRIMARY KEY, qty REAL NOT NULL, avg_price REAL NOT NULL,
  realized_pnl REAL NOT NULL DEFAULT 0, unrealized_pnl REAL NOT NULL DEFAULT 0,
  as_of INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS risk_audits(
  decision_id TEXT PRIMARY KEY, policy_version TEXT NOT NULL,
  checks_json TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS safety_audits(
  order_ref TEXT PRIMARY KEY, verdict TEXT NOT NULL,
  reasons_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency_keys(
  key TEXT PRIMARY KEY, order_id TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

export function initDb(db: { exec(sql: string): void }, ddl: string): void {
  db.exec(ddl);
}
