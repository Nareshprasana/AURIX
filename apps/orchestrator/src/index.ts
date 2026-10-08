// @aurix/orchestrator — ModeMachine + promotion check skeleton (Amendment 5).
import type { LiveTradingPromotion, Mode, PromotionState } from '@aurix/contracts';

const ORDER_MODES: Mode[] = ['PAPER', 'SHADOW'];
const LIVE_MODES: Mode[] = ['CONTROLLED_LIVE', 'AUTONOMOUS_LIVE'];

export class ModeMachine {
  private history: Mode[] = [];
  constructor(private current: Mode = 'RESEARCH') {
    this.history.push(current);
  }
  get mode(): Mode {
    return this.current;
  }
  transition(next: Mode): void {
    // Phase 1: live transitions unreachable — no ACTIVE promotion can exist.
    if (LIVE_MODES.includes(next)) {
      throw new Error(`Phase 1: transition to ${next} impossible without ACTIVE promotion`);
    }
    this.history.push(next);
    this.current = next;
  }
  allowsOrders(): boolean {
    return ORDER_MODES.includes(this.current);
  }
  getHistory(): Mode[] {
    return [...this.history];
  }
}

export function createDraftPromotion(systemVersion: string): LiveTradingPromotion {
  return {
    promotion_id: `promo-${Date.now()}`,
    system_version: systemVersion,
    risk_policy_version: 'v1',
    model_version: 'none',
    strategy_versions: [],
    validation_results_ref: 'none',
    paper_trading_results_ref: 'none',
    approval_timestamp: null,
    operator_identity: null,
    state: 'DRAFT'
  };
}

/** Phase 1: allowLive is ALWAYS false. Config alone can never enable live orders. */
export function isLiveAllowed(_promotion: LiveTradingPromotion, _mode: Mode): boolean {
  const state: PromotionState = _promotion.state;
  if (state !== 'ACTIVE') return false;
  // Belt-and-braces: Phase 1 has no activation path, so even ACTIVE is rejected here.
  void _mode;
  return false;
}
