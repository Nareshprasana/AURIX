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
}

export interface PortfolioSnapshot {
  equity: number;
  grossExposurePct: number;
  sectorExposurePct: Record<string, number>;
  dailyLossPct: number;
  drawdownPct: number;
  marginUtilPct: number;
  leverage: number;
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
  const maxNotional = (portfolio.equity * policy.max_position_notional_pct) / 100;
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

  if (allow) reasons.push('within policy');
  const cappedQty = allow ? proposal.quantity : 0;
  return { allow, cappedQty, reasons, policyVersion: policy.version };
}
