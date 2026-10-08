import { describe, expect, it } from 'vitest';
import { CORE_DDL, KNOWLEDGE_DDL, PORTFOLIO_DDL } from '../src/index.js';

describe('db-bootstrap', () => {
  it('core DDL covers instruments/eligibility/market-status/events/modes/promotions', () => {
    for (const t of ['instruments', 'eligibility', 'market_status', 'events', 'modes', 'promotions']) {
      expect(CORE_DDL).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
    }
    expect(CORE_DDL).toMatch(/journal_mode=WAL/);
    expect(CORE_DDL).toMatch(/CREATE INDEX IF NOT EXISTS idx_events_poll/);
  });

  it('knowledge DDL has append-only knowledge_events (no UPDATE/DELETE API)', () => {
    expect(KNOWLEDGE_DDL).toMatch(/CREATE TABLE IF NOT EXISTS knowledge_events/);
    expect(KNOWLEDGE_DDL).not.toMatch(/DROP TABLE/);
  });

  it('portfolio DDL has decisions/orders/fills/positions/risk+safety audits/idempotency', () => {
    for (const t of ['decisions', 'orders', 'fills', 'positions', 'risk_audits', 'safety_audits', 'idempotency_keys']) {
      expect(PORTFOLIO_DDL).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
    }
  });
});
