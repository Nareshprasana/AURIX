import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

describe('strategy layer isolation', () => {
  it('strategy and backtest sources touch no broker/execution/gateway/training and no dynamic code', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${f.name}`;
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.ts')) files.push(p);
      }
    };
    walk('packages/strategy/src');
    walk('apps/backtest/src');
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/@aurix\/(broker-sim|broker-kite|execution-service|risk-engine|portfolio-engine|model-gateway)/);
      expect(src).not.toMatch(/\bplaceOrder\b|BrokerPort|kiteconnect/);
      expect(src).not.toMatch(/\beval\s*\(|new Function\s*\(|child_process|execSync|spawnSync/);
    }
  });

  it('hypothetical orders are structurally incompatible with broker orders', () => {
    // HypotheticalOrder carries simulation fields (ts_signal/ts_execute/ref_price/reason)
    // and no broker routing fields (no brokerOrderId, no credentials, no mode).
    const shape = ['id', 'strategy_id', 'strategy_version', 'instrument_id', 'ts_signal', 'ts_execute', 'side', 'qty', 'ref_price', 'reason'];
    const forbidden = ['brokerOrderId', 'broker_order_id', 'credentials', 'api_key', 'mode', 'allow_live'];
    const src = readFileSync('packages/strategy/src/types.ts', 'utf8');
    for (const f of shape) expect(src).toContain(f);
    const orderBlock = src.slice(src.indexOf('export interface HypotheticalOrder'), src.indexOf('export interface Fill'));
    for (const f of forbidden) expect(orderBlock).not.toContain(f);
  });

  it('strategy definitions reject credential-shaped material at registration', () => {
    // Covered in registry tests; this asserts the scan hook exists in the path.
    const src = readFileSync('apps/backtest/src/registry.ts', 'utf8');
    expect(src).toMatch(/containsSecretPayload/);
  });
});
