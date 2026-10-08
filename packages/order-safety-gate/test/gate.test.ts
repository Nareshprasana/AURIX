import { describe, expect, it } from 'vitest';
import { validateOrder } from '../src/index.js';
import type { Instrument, OrderCmd, SafetyContext } from '@aurix/contracts';

const EQUITY_INSTRUMENT: Instrument = {
  id: 'NSE_EQ_RELIANCE',
  exchange: 'NSE',
  market: 'equity',
  segment: 'EQ',
  symbol: 'RELIANCE',
  isin: 'INE002A01018',
  lot_size: 1,
  tick_size: 0.05,
  contract: null
};

const NOW = 1_700_000_000_000;

function baseCmd(over: Partial<OrderCmd> = {}): OrderCmd {
  return {
    clientOrderId: 'coid-1',
    decisionId: 'dec-1',
    instrumentId: 'NSE_EQ_RELIANCE',
    exchange: 'NSE',
    segment: 'EQ',
    side: 'BUY',
    quantity: 10,
    orderType: 'LIMIT',
    limitPrice: 100,
    strategyId: 'strat-v1',
    ...over
  };
}

function baseCtx(over: Partial<SafetyContext> = {}): SafetyContext {
  return {
    instrument: EQUITY_INSTRUMENT,
    eligibility: 'LEGAL',
    marketStatus: 'OPEN',
    riskVerdict: { allow: true, cappedQty: 10, reasons: ['within policy'], policyVersion: 'v1' },
    mode: 'PAPER',
    promotionActive: false,
    strategyAuthorized: true,
    riskHalted: false,
    nowTs: NOW,
    decisionTs: NOW - 5_000,
    marketDataTs: NOW - 5_000,
    decisionTtlS: 60,
    marketDataStalenessS: 120,
    seenIdempotencyKeys: new Set<string>(),
    lastPrice: 100,
    brokerMaxQty: 1000,
    ...over
  };
}

describe('order-safety-gate', () => {
  it('ALLOWs a valid order', () => {
    expect(validateOrder(baseCmd(), baseCtx()).verdict).toBe('ALLOW');
  });
  it('rejects wrong symbol', () => {
    const v = validateOrder(baseCmd({ instrumentId: 'WRONG' }), baseCtx());
    expect(v.verdict).toBe('REJECT');
  });
  it('rejects wrong exchange', () => {
    const v = validateOrder(baseCmd({ exchange: 'BSE' }), baseCtx());
    expect(v.verdict).toBe('REJECT');
  });
  it('rejects zero quantity', () => {
    expect(validateOrder(baseCmd({ quantity: 0 }), baseCtx()).verdict).toBe('REJECT');
  });
  it('rejects negative quantity', () => {
    expect(validateOrder(baseCmd({ quantity: -5 }), baseCtx()).verdict).toBe('REJECT');
  });
  it('rejects oversized quantity', () => {
    expect(validateOrder(baseCmd({ quantity: 99999 }), baseCtx()).verdict).toBe('REJECT');
  });
  it('rejects invalid lot size', () => {
    const lot5 = { ...EQUITY_INSTRUMENT, lot_size: 5 };
    expect(validateOrder(baseCmd({ quantity: 7 }), baseCtx({ instrument: lot5 })).verdict).toBe('REJECT');
  });
  it('rejects invalid tick size', () => {
    expect(validateOrder(baseCmd({ limitPrice: 100.03 }), baseCtx()).verdict).toBe('REJECT');
  });
  it('rejects stale price', () => {
    expect(validateOrder(baseCmd({ limitPrice: 150 }), baseCtx({ lastPrice: 100 })).verdict).toBe('REJECT');
  });
  it('rejects stale decision', () => {
    expect(validateOrder(baseCmd(), baseCtx({ decisionTs: NOW - 600_000 })).verdict).toBe('REJECT');
  });
  it('rejects duplicate order', () => {
    expect(validateOrder(baseCmd(), baseCtx({ seenIdempotencyKeys: new Set(['coid-1']) })).verdict).toBe('REJECT');
  });
  it('rejects unknown instrument', () => {
    expect(validateOrder(baseCmd(), baseCtx({ instrument: null })).verdict).toBe('REJECT');
  });
  it('rejects restricted instrument', () => {
    expect(validateOrder(baseCmd(), baseCtx({ eligibility: 'RESTRICTED' })).verdict).toBe('REJECT');
    expect(validateOrder(baseCmd(), baseCtx({ eligibility: 'UNKNOWN' })).verdict).toBe('REJECT');
  });
  it('rejects halted market', () => {
    expect(validateOrder(baseCmd(), baseCtx({ marketStatus: 'HALT' })).verdict).toBe('REJECT');
  });
  it('rejects invalid risk state (halt active)', () => {
    expect(validateOrder(baseCmd(), baseCtx({ riskHalted: true })).verdict).toBe('REJECT');
  });
  it('rejects wrong mode (RESEARCH orders)', () => {
    expect(validateOrder(baseCmd(), baseCtx({ mode: 'RESEARCH' })).verdict).toBe('REJECT');
  });
  it('rejects missing risk verdict', () => {
    expect(validateOrder(baseCmd(), baseCtx({ riskVerdict: null })).verdict).toBe('REJECT');
  });
  it('rejects risk REJECT verdict', () => {
    const ctx = baseCtx({ riskVerdict: { allow: false, cappedQty: 0, reasons: ['oversized'], policyVersion: 'v1' } });
    expect(validateOrder(baseCmd(), ctx).verdict).toBe('REJECT');
  });
  it('rejects stale market data', () => {
    expect(validateOrder(baseCmd(), baseCtx({ marketDataTs: NOW - 600_000 })).verdict).toBe('REJECT');
  });
});
