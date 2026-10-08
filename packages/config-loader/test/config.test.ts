import { describe, expect, it } from 'vitest';
import { loadConfig, validateConfig } from '../src/index.js';

describe('config-loader', () => {
  it('loads Phase 1 defaults', () => {
    const cfg = loadConfig('config/default.yaml');
    expect(cfg.mode).toBe('RESEARCH');
    expect(cfg.broker).toBe('sim');
    expect(cfg.safety.allow_live).toBe(false);
  });

  it('rejects non-sim broker', () => {
    const cfg = loadConfig('config/default.yaml');
    expect(validateConfig({ ...cfg, broker: 'kite' as never })).not.toHaveLength(0);
  });

  it('rejects allow_live=true', () => {
    const cfg = loadConfig('config/default.yaml');
    expect(validateConfig({ ...cfg, safety: { ...cfg.safety, allow_live: true } })).not.toHaveLength(0);
  });

  it('accepts any model string (configurable, Amendment 1)', () => {
    const cfg = loadConfig('config/default.yaml');
    const a = validateConfig({ ...cfg, model_gateway: { ...cfg.model_gateway, model: 'model-a' } });
    const b = validateConfig({ ...cfg, model_gateway: { ...cfg.model_gateway, model: 'totally-different-model' } });
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(0);
  });

  it('rejects live modes in Phase 1', () => {
    const cfg = loadConfig('config/default.yaml');
    expect(validateConfig({ ...cfg, mode: 'AUTONOMOUS_LIVE' }).length).toBeGreaterThan(0);
  });

  it('rejects mode escalation via environment overlay', () => {
    process.env.AURIX_MODE = 'AUTONOMOUS_LIVE';
    try {
      expect(() => loadConfig('config/default.yaml')).toThrow(/AUTONOMOUS_LIVE|live/i);
    } finally {
      delete process.env.AURIX_MODE;
    }
  });

  it('rejects broker escalation via environment overlay', () => {
    process.env.AURIX_BROKER = 'kite';
    try {
      expect(() => loadConfig('config/default.yaml')).toThrow(/sim/);
    } finally {
      delete process.env.AURIX_BROKER;
    }
  });
});
