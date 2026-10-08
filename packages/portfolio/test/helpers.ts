import { buildCapital, computeExposure, concentration, correlationView, sectorExposure } from '../src/index.js';
import type { PositionView } from '../src/index.js';

export function pos(id: string, mv: number, over: Partial<PositionView> = {}): PositionView {
  return {
    position_id: `pos-${id}`,
    instrument_id: id,
    qty: Math.abs(mv) / 100,
    side: mv >= 0 ? 1 : -1,
    avg_price: 100,
    mark_price: 100,
    market_value: mv,
    weight_pct: 0,
    realized_pnl: 0,
    unrealized_pnl: 0,
    strategy_id: 'test:roc',
    strategy_version: 1,
    sector: null,
    asset_class: 'equity',
    liquidity: { adv_value: 1e9, spread_bps: 5 },
    updated_at: 1,
    ...over
  };
}

export const PROFILE = { total: 1_000_000, reserved_pct: 0, base_currency: 'INR' };
