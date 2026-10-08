// @aurix/risk-engine — deterministic veto logic. No network, no LLM.
import type { EligibilityState, MarketStatus, RiskVerdict } from '@aurix/contracts';
import type { RiskPolicy } from '@aurix/config-loader';

export interface Proposal {
  instrumentId: string;
  notional: number;
  quantity: number;
  sector: string;
  eligibility: EligibilityState;
  marketStatus: MarketStatus;
  /** Market regime label (e.g. HIGH_VOLATILITY); absent = no haircut applied. */
  regime?: string;
  /** Proposed notional as % of average daily volume; absent = liquidity check skipped. */
  notionalAdvPct?: number;
  /** Current bid/ask spread in bps; absent = spread check skipped. */
  spreadBps?: number;
}

export interface PortfolioSnapshot {
  equity: number;
  grossExposurePct: number;
  sectorExposurePct: Record<string, number>;
  dailyLossPct: number;
  drawdownPct: number;
  marginUtilPct: number;
  leverage: number;
  /** Top-5 concentration %; absent = concentration check skipped. */
  top5ConcentrationPct?: number;
}

export function evaluate(
  proposal: Proposal,
  portfolio: PortfolioSnapshot,
  policy: RiskPolicy
): RiskVerdict {
  const reasons: string[] = [];
  let allow = true;

  // UNKNOWN eligibility is fail-closed (UNKNOWN != ALLOWED).
  if (proposal.eligibility !== 'LEGAL') {
    allow = false;
    reasons.push(`eligibility not LEGAL: ${proposal.eligibility}`);
  }
  if (proposal.marketStatus === 'HALT' || proposal.marketStatus === 'AUCTION' || proposal.marketStatus === 'UNKNOWN') {
    allow = false;
    reasons.push(`invalid market state: ${proposal.marketStatus}`);
  }
  let maxNotional = (portfolio.equity * policy.max_position_notional_pct) / 100;
  // Abnormal-market haircut: reduce the per-position cap (architecture §11).
  if (proposal.regime && policy.abnormal_states.includes(proposal.regime)) {
    maxNotional *= 1 - policy.abnormal_market_haircut_pct / 100;
    reasons.push(`abnormal regime ${proposal.regime}: cap reduced to ${maxNotional}`);
  }
  if (proposal.notional > maxNotional) {
    allow = false;
    reasons.push(`oversized: notional ${proposal.notional} > cap ${maxNotional}`);
  }
  const sectorExp = portfolio.sectorExposurePct[proposal.sector] ?? 0;
  if (sectorExp >= policy.max_sector_pct) {
    allow = false;
    reasons.push(`sector exposure ${sectorExp}% >= cap ${policy.max_sector_pct}%`);
  }
  if (portfolio.grossExposurePct >= policy.max_portfolio_gross_pct.paper_shadow) {
    allow = false;
    reasons.push(`portfolio exposure ${portfolio.grossExposurePct}% >= cap`);
  }
  if (portfolio.dailyLossPct >= policy.max_daily_loss_pct) {
    allow = false;
    reasons.push('daily loss limit breached');
  }
  if (portfolio.drawdownPct >= policy.max_drawdown_pct) {
    allow = false;
    reasons.push('max drawdown breached');
  }
  if (portfolio.leverage > policy.max_leverage) {
    allow = false;
    reasons.push('leverage breach');
  }
  if (portfolio.marginUtilPct > policy.max_margin_util_pct) {
    allow = false;
    reasons.push(`margin utilization ${portfolio.marginUtilPct}% > cap ${policy.max_margin_util_pct}%`);
  }
  if (portfolio.top5ConcentrationPct !== undefined && portfolio.top5ConcentrationPct >= policy.concentration_top5_pct) {
    allow = false;
    reasons.push(`concentration ${portfolio.top5ConcentrationPct}% >= cap ${policy.concentration_top5_pct}%`);
  }
  if (proposal.notionalAdvPct !== undefined && proposal.notionalAdvPct > policy.liquidity_max_adv_pct) {
    allow = false;
    reasons.push(`illiquid: notional ${proposal.notionalAdvPct}% of ADV > cap ${policy.liquidity_max_adv_pct}%`);
  }
  if (proposal.spreadBps !== undefined && proposal.spreadBps > policy.liquidity_max_spread_bps) {
    allow = false;
    reasons.push(`spread ${proposal.spreadBps}bps > cap ${policy.liquidity_max_spread_bps}bps`);
  }

  if (allow) reasons.push('within policy');
  const cappedQty = allow ? proposal.quantity : 0;
  return { allow, cappedQty, reasons, policyVersion: policy.version };
}
