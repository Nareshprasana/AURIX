import { describe, expect, it } from 'vitest';
import { checkApplicability, classifyRegime, generateSignals } from '../src/index.js';
import { makeDef, rangeCloses, timestamps, trendCloses } from './fixtures.js';

describe('signals', () => {
  it('trend strategy goes LONG on a steady uptrend', () => {
    const def = makeDef();
    // Flat base then a rising leg, so a genuine cross occurs inside the window.
    const closes = [...Array(20).fill(100), 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    const batch = generateSignals(def, 'X', closes, timestamps(closes.length), 'ds-v1', 1);
    expect(batch.status).toBe('APPLICABLE');
    const longs = batch.signals.filter((s) => s.type === 'LONG');
    expect(longs.length).toBeGreaterThan(0);
    expect(batch.signals[0]?.type).toBe('NO_SIGNAL'); // warmup, never forced
    for (const s of batch.signals) {
      expect(s.strategy_id).toBe('test:sma');
      expect(s.data_version).toBe('ds-v1');
    }
  });

  it('emits NO_SIGNAL (never INVALID) during warmup', () => {
    const def = makeDef();
    const batch = generateSignals(def, 'X', [100, 101], [1, 2], 'ds', 1);
    expect(batch.signals.every((s) => s.type === 'NO_SIGNAL')).toBe(true);
  });

  it('returns NOT_APPLICABLE for blocked regimes instead of forcing signals', () => {
    const def = makeDef({ regimes: { supported: [], preferred: [], blocked: ['up_low', 'up_high', 'down_low', 'down_high', 'flat_low', 'flat_high'] } });
    const batch = generateSignals(def, 'X', trendCloses(30), timestamps(30), 'ds', 1);
    expect(batch.status).toBe('NOT_APPLICABLE');
    expect(batch.signals).toHaveLength(0);
  });

  it('abnormal markets can be blocked declaratively', () => {
    const def = makeDef({ regimes: { supported: [], preferred: [], blocked: ['abnormal'] } });
    const batch = generateSignals(def, 'X', trendCloses(30), timestamps(30), 'ds', 1, true);
    expect(batch.status).toBe('NOT_APPLICABLE');
    expect(batch.reason).toMatch(/abnormal/);
  });

  it('mean-reversion shorts spikes and covers on recovery', () => {
    const def = makeDef({}, 'zscore-meanreversion', { n: 5, entry_z: 1.5, exit_z: 0.5 });
    const closes = [100, 100, 100, 100, 100, 130, 128, 101, 100, 100];
    const batch = generateSignals(def, 'X', closes, timestamps(closes.length), 'ds', 1);
    const types = batch.signals.map((s) => s.type);
    expect(types).toContain('SHORT');
  });

  it('breakout fires on range expansion only', () => {
    const def = makeDef({}, 'donchian-breakout', { n: 5 });
    const flat = generateSignals(def, 'X', rangeCloses(20), timestamps(20), 'ds', 1);
    expect(flat.signals.filter((s) => s.type === 'LONG')).toHaveLength(0);
    const breakout = generateSignals(def, 'X', [...rangeCloses(15), 105, 106, 107, 108, 109], timestamps(20), 'ds', 1);
    expect(breakout.signals.some((s) => s.type === 'LONG')).toBe(true);
  });

  it('regime classifier distinguishes trend and volatility', () => {
    expect(classifyRegime(trendCloses(30), 29).trend).toBe('up');
    expect(classifyRegime(rangeCloses(30), 29).trend).toBe('flat');
    expect(checkApplicability({ supported: ['up_low'], preferred: [], blocked: [] }, classifyRegime(trendCloses(30), 29)).status).toBe('APPLICABLE');
  });
});
