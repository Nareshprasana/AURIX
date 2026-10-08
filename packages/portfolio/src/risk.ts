// Deterministic portfolio risk evaluation reusing Phase 1 safety defaults.
// Verdicts: ALLOW / REDUCE (capped, binding rule cited) / REJECT / UNKNOWN.
// UNKNOWN (missing/invalid critical inputs) never becomes ALLOW.
import type {
  DataQualityMap,
  DrawdownState,
  PortfolioCandidate,
  RiskDecision,
  RiskVerdictValue
} from './types.js';

export interface RiskPolicyInput {
  version: string;
  max_position_pct: number;
  max_gross_pct: number;
  max_sector_pct: number;
  max_leverage: number;
  max_margin_pct: number;
  max_daily_loss_pct: number;
  max_drawdown_pct: number;
  liquidity_max_adv_pct: number;
  liquidity_max_spread_bps: number;
  concentration_top5_pct: number;
  abnormal_haircut_pct: number;
  drawdown_caution_pct: number;
  drawdown_restricted_pct: number;
  unknown_sector_cap_pct: number;
  correlation_cluster_cap_pct: number;
  correlation_threshold: number;
}

export const PHASE1_DEFAULTS: RiskPolicyInput = {
  version: 'risk policy v1 + portfolio extras v1',
  max_position_pct: 2.0,
  max_gross_pct: 60.0,
  max_sector_pct: 20.0,
  max_leverage: 1.0,
  max_margin_pct: 50.0,
  max_daily_loss_pct: 1.5,
  max_drawdown_pct: 8.0,
  liquidity_max_adv_pct: 5.0,
  liquidity_max_spread_bps: 50,
  concentration_top5_pct: 40.0,
  abnormal_haircut_pct: 50.0,
  drawdown_caution_pct: 4.0,
  drawdown_restricted_pct: 6.0,
  unknown_sector_cap_pct: 10.0,
  correlation_cluster_cap_pct: 6.0,
  correlation_threshold: 0.7
};

export interface CandidateRiskInput {
  candidate: PortfolioCandidate;
  weight_pct: number;
  sector: string | null;
  equity: number;
  price: number | null;
  strategyAuthorized: boolean;
  modeAllowsOrders: boolean;
}

export interface PortfolioRiskInput {
  portfolio_id: string;
  candidates: CandidateRiskInput[];
  current: {
    gross_pct: number;
    sector_pct: Record<string, number>;
    top5_pct: number;
    leverage: number;
    margin_pct: number;
    daily_loss_pct: number;
    drawdown_pct: number;
  };
  market: { abnormal: boolean; haltedIds: string[] };
  quality: DataQualityMap;
  correlations?: Record<string, Record<string, number | null>>;
  trace_id: string;
}

export interface CandidateRiskVerdict {
  candidate_id: string;
  instrument_id: string;
  verdict: RiskVerdictValue;
  approved_weight_pct: number;
  decisions: RiskDecision[];
  reasons: string[];
}

function decision(
  portfolioId: string,
  candidateId: string | null,
  ruleId: string,
  observed: number | null,
  limit: number | null,
  verdict: RiskVerdictValue,
  explanation: string,
  policy: RiskPolicyInput,
  traceId: string,
  now: number,
  seq: number
): RiskDecision {
  const utilization = observed !== null && limit !== null && limit !== 0 ? (observed / limit) * 100 : null;
  return {
    decision_id: `risk-${traceId}-${seq}`,
    portfolio_id: portfolioId,
    candidate_id: candidateId,
    rule_id: ruleId,
    observed,
    limit,
    utilization_pct: utilization,
    decision: verdict,
    explanation,
    timestamp: now,
    config_version: policy.version,
    evidence_ref: candidateId,
    trace_id: traceId
  };
}

export function drawdownState(drawdownPct: number, dailyLossPct: number, policy: RiskPolicyInput): DrawdownState {
  const dd = Math.abs(drawdownPct);
  if (dd >= policy.max_drawdown_pct || dailyLossPct >= policy.max_daily_loss_pct) return 'HALTED';
  if (dd >= policy.drawdown_restricted_pct) return 'RESTRICTED';
  if (dd >= policy.drawdown_caution_pct) return 'CAUTION';
  return 'NORMAL';
}

function qualityOf(quality: DataQualityMap, key: string): string {
  return quality[key] ?? 'MISSING';
}

function criticalQualityFail(quality: DataQualityMap, keys: string[]): string | null {
  for (const k of keys) {
    const q = qualityOf(quality, k);
    if (q === 'QUARANTINED' || q === 'STALE' || q === 'UNKNOWN' || q === 'MISSING') {
      return `${k}=${q}`;
    }
  }
  return null;
}

export interface PortfolioRiskResult {
  candidates: CandidateRiskVerdict[];
  portfolioVerdict: RiskVerdictValue;
  drawdownState: DrawdownState;
  portfolioDecisions: RiskDecision[];
  grossPct: number;
}

export function evaluatePortfolioRisk(
  input: PortfolioRiskInput,
  policy: RiskPolicyInput = PHASE1_DEFAULTS,
  now = Date.now()
): PortfolioRiskResult {
  let seq = 0;
  const portfolioDecisions: RiskDecision[] = [];
  const ddState = drawdownState(input.current.drawdown_pct, input.current.daily_loss_pct, policy);
  const haircut = input.market.abnormal || ddState === 'RESTRICTED' ? 1 - policy.abnormal_haircut_pct / 100 : 1;
  const posCap = policy.max_position_pct * haircut;
  const sectorCap = policy.max_sector_pct * haircut;

  const mk = (
    candidateId: string | null, ruleId: string, observed: number | null, limit: number | null,
    verdict: RiskVerdictValue, explanation: string
  ): RiskDecision => {
    seq += 1;
    return decision(input.portfolio_id, candidateId, ruleId, observed, limit, verdict, explanation, policy, input.trace_id, now, seq);
  };

  // Portfolio-level gates first (halt conditions veto everything).
  let portfolioVerdict: RiskVerdictValue = 'ALLOW';
  if (ddState === 'HALTED') {
    portfolioDecisions.push(mk(null, 'drawdown-halt', Math.abs(input.current.drawdown_pct), policy.max_drawdown_pct, 'REJECT', `drawdown state HALTED (dd=${input.current.drawdown_pct}%, daily=${input.current.daily_loss_pct}%)`));
    portfolioVerdict = 'REJECT';
  }
  if (input.current.daily_loss_pct >= policy.max_daily_loss_pct) {
    portfolioDecisions.push(mk(null, 'daily-loss-halt', input.current.daily_loss_pct, policy.max_daily_loss_pct, 'REJECT', 'daily loss limit breached: no new risk'));
    portfolioVerdict = 'REJECT';
  }
  if (input.current.leverage > policy.max_leverage) {
    portfolioDecisions.push(mk(null, 'leverage', input.current.leverage, policy.max_leverage, 'REJECT', 'leverage breach: no new risk'));
    portfolioVerdict = 'REJECT';
  }
  if (input.current.margin_pct > policy.max_margin_pct) {
    portfolioDecisions.push(mk(null, 'margin', input.current.margin_pct, policy.max_margin_pct, 'REJECT', 'margin utilization breach: no new risk'));
    portfolioVerdict = 'REJECT';
  }

  // Gross headroom shared across candidates.
  const proposedGross = input.candidates.reduce((s, c) => s + Math.max(0, c.weight_pct), 0);
  const grossHeadroom = Math.max(0, policy.max_gross_pct - input.current.gross_pct);
  const grossScale = proposedGross > grossHeadroom && proposedGross > 0 ? grossHeadroom / proposedGross : 1;
  if (grossScale < 1) {
    portfolioDecisions.push(mk(null, 'gross-exposure', input.current.gross_pct + proposedGross, policy.max_gross_pct, 'REDUCE', `gross would reach ${(input.current.gross_pct + proposedGross).toFixed(2)}% vs cap ${policy.max_gross_pct}%: scaling ${(grossScale * 100).toFixed(1)}%`));
  }

  // Sector headroom per sector.
  const sectorUsed: Record<string, number> = { ...input.current.sector_pct };
  const sectorProp: Record<string, number> = {};
  for (const c of input.candidates) {
    if (c.sector) sectorProp[c.sector] = (sectorProp[c.sector] ?? 0) + Math.max(0, c.weight_pct);
  }

  const unknownSectorWeight = input.candidates
    .filter((c) => !c.sector)
    .reduce((s, c) => s + Math.max(0, c.weight_pct), 0);
  if (unknownSectorWeight > policy.unknown_sector_cap_pct) {
    portfolioDecisions.push(mk(null, 'unknown-sector', unknownSectorWeight, policy.unknown_sector_cap_pct, 'REJECT', `unknown-sector weight ${unknownSectorWeight.toFixed(2)}% exceeds cap ${policy.unknown_sector_cap_pct}% (classification missing, never assumed zero)`));
    if (portfolioVerdict === 'ALLOW') portfolioVerdict = 'REJECT';
  }

  const candidates: CandidateRiskVerdict[] = input.candidates.map((c) => {
    const cid = c.candidate.candidate_id;
    const iid = c.candidate.instrument.instrument_id;
    const decisions: RiskDecision[] = [];
    const reasons: string[] = [];
    let verdict: RiskVerdictValue = 'ALLOW';
    let approved = Math.max(0, c.weight_pct);
    const escalate = (v: RiskVerdictValue): void => {
      const rank = { ALLOW: 0, REDUCE: 1, UNKNOWN: 2, REJECT: 3 };
      if (rank[v] > rank[verdict]) verdict = v;
    };

    // Data-quality gate on critical inputs (fail-safe: UNKNOWN, never ALLOW).
    const qFail = criticalQualityFail(input.quality, [
      `price:${c.candidate.instrument.instrument_id}`,
      `adv:${c.candidate.instrument.instrument_id}`,
      `spread:${c.candidate.instrument.instrument_id}`,
      `sector:${c.candidate.instrument.instrument_id}`,
      `vol:${c.candidate.instrument.instrument_id}`
    ]);
    if (qFail) {
      decisions.push(mk(cid, 'data-quality', null, null, 'UNKNOWN', `critical input ${qFail}: cannot evaluate risk`));
      reasons.push(`UNKNOWN: ${qFail}`);
      escalate('UNKNOWN');
      return { candidate_id: cid, instrument_id: c.candidate.instrument.instrument_id, verdict, approved_weight_pct: 0, decisions, reasons };
    }
    if (input.market.haltedIds.includes(c.candidate.instrument.instrument_id)) {
      decisions.push(mk(cid, 'market-halted', null, null, 'REJECT', 'instrument halted'));
      reasons.push('REJECT: halted');
      return { candidate_id: cid, instrument_id: c.candidate.instrument.instrument_id, verdict: 'REJECT', approved_weight_pct: 0, decisions, reasons };
    }
    if (!c.strategyAuthorized) {
      decisions.push(mk(cid, 'strategy-auth', null, null, 'REJECT', 'strategy not authorized for this instrument'));
      reasons.push('REJECT: strategy unauthorized');
      return { candidate_id: cid, instrument_id: c.candidate.instrument.instrument_id, verdict: 'REJECT', approved_weight_pct: 0, decisions, reasons };
    }
    if (!c.modeAllowsOrders) {
      decisions.push(mk(cid, 'mode-auth', null, null, 'REJECT', 'mode does not allow new positions'));
      reasons.push('REJECT: wrong mode');
      return { candidate_id: cid, instrument_id: c.candidate.instrument.instrument_id, verdict: 'REJECT', approved_weight_pct: 0, decisions, reasons };
    }
    if (c.price === null || !(c.price > 0) || !(c.equity > 0)) {
      decisions.push(mk(cid, 'pricing', c.price, null, 'UNKNOWN', 'missing price or equity: cannot size risk'));
      reasons.push('UNKNOWN: pricing');
      escalate('UNKNOWN');
      return { candidate_id: cid, instrument_id: c.candidate.instrument.instrument_id, verdict, approved_weight_pct: 0, decisions, reasons };
    }
    // Position cap (haircut-aware).
    if (approved > posCap) {
      decisions.push(mk(cid, 'position-cap', approved, posCap, 'REDUCE', `weight ${approved.toFixed(2)}% > position cap ${posCap.toFixed(2)}%${haircut < 1 ? ' (haircut applied)' : ''}`));
      reasons.push(`REDUCE to position cap ${posCap.toFixed(2)}%`);
      approved = posCap;
      escalate('REDUCE');
    }
    // Sector cap against remaining headroom.
    if (c.sector) {
      const headroom = Math.max(0, sectorCap - (sectorUsed[c.sector] ?? 0));
      if (approved > headroom) {
        decisions.push(mk(cid, 'sector-cap', (sectorUsed[c.sector] ?? 0) + approved, sectorCap, headroom <= 0 ? 'REJECT' : 'REDUCE', `sector ${c.sector} headroom ${headroom.toFixed(2)}%`));
        reasons.push(headroom <= 0 ? 'REJECT: sector full' : `REDUCE to ${headroom.toFixed(2)}%`);
        approved = headroom;
        escalate(headroom <= 0 ? 'REJECT' : 'REDUCE');
      }
      sectorUsed[c.sector] = (sectorUsed[c.sector] ?? 0) + approved;
    } else {
      decisions.push(mk(cid, 'sector-unknown', null, policy.unknown_sector_cap_pct, 'REJECT', 'sector classification missing'));
      reasons.push('REJECT: unknown sector');
      return { candidate_id: cid, instrument_id: c.candidate.instrument.instrument_id, verdict: 'REJECT', approved_weight_pct: 0, decisions, reasons };
    }
    // Gross scaling.
    if (grossScale < 1) {
      approved = approved * grossScale;
      decisions.push(mk(cid, 'gross-scale', null, null, 'REDUCE', `scaled ${(grossScale * 100).toFixed(1)}% for gross headroom`));
      reasons.push('REDUCE: gross scale');
      escalate('REDUCE');
    }
    // Liquidity: ADV share + spread.
    const notional = (approved / 100) * c.equity;
    const adv = c.candidate.liquidity.adv_value;
    if (adv === null || adv === undefined || !(adv > 0)) {
      decisions.push(mk(cid, 'liquidity-adv', null, null, 'UNKNOWN', 'ADV unknown: cannot verify participation'));
      reasons.push('UNKNOWN: adv');
      escalate('UNKNOWN');
      return { candidate_id: cid, instrument_id: c.candidate.instrument.instrument_id, verdict, approved_weight_pct: 0, decisions, reasons };
    }
    const advShare = (notional / adv) * 100;
    if (advShare > policy.liquidity_max_adv_pct) {
      const cappedNotional = adv * (policy.liquidity_max_adv_pct / 100);
      approved = (cappedNotional / c.equity) * 100;
      decisions.push(mk(cid, 'liquidity-adv', advShare, policy.liquidity_max_adv_pct, 'REDUCE', `ADV share ${advShare.toFixed(2)}% > ${policy.liquidity_max_adv_pct}%`));
      reasons.push('REDUCE: adv');
      escalate('REDUCE');
    }
    const spread = c.candidate.liquidity.spread_bps;
    if (spread === null || spread === undefined) {
      decisions.push(mk(cid, 'liquidity-spread', null, null, 'UNKNOWN', 'spread unknown'));
      reasons.push('UNKNOWN: spread');
      escalate('UNKNOWN');
      return { candidate_id: cid, instrument_id: c.candidate.instrument.instrument_id, verdict, approved_weight_pct: 0, decisions, reasons };
    }
    if (spread > policy.liquidity_max_spread_bps) {
      decisions.push(mk(cid, 'liquidity-spread', spread, policy.liquidity_max_spread_bps, 'REJECT', `spread ${spread}bps > ${policy.liquidity_max_spread_bps}bps`));
      reasons.push('REJECT: spread');
      return { candidate_id: cid, instrument_id: c.candidate.instrument.instrument_id, verdict: 'REJECT', approved_weight_pct: 0, decisions, reasons };
    }
    if (approved <= 0 && verdict === 'ALLOW') {
      decisions.push(mk(cid, 'dust', approved, null, 'REJECT', 'approved weight rounds to zero'));
      reasons.push('REJECT: dust');
      return { candidate_id: cid, instrument_id: c.candidate.instrument.instrument_id, verdict: 'REJECT', approved_weight_pct: 0, decisions, reasons };
    }
    if (verdict === 'ALLOW') {
      decisions.push(mk(cid, 'within-limits', approved, posCap, 'ALLOW', 'within all caps'));
      reasons.push('ALLOW');
    }
    return { candidate_id: cid, instrument_id: c.candidate.instrument.instrument_id, verdict, approved_weight_pct: Math.max(0, approved), decisions, reasons };
  });

  // Correlation clusters over connected components (transitive): a cluster whose
  // combined approved weight exceeds the cap is scaled pro-rata (conservative).
  if (input.correlations) {
    const ids = [...new Set(candidates.map((c) => c.instrument_id))].sort();
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (x: string): string => {
      const p = parent.get(x)!;
      if (p !== x) parent.set(x, find(p));
      return parent.get(x)!;
    };
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b) continue;
        const rho = input.correlations[a]?.[b] ?? input.correlations[b]?.[a] ?? null;
        if (rho !== null && Math.abs(rho) >= policy.correlation_threshold) {
          parent.set(find(a), find(b));
        }
      }
    }
    const components = new Map<string, typeof candidates>();
    for (const c of candidates) {
      const root = ids.includes(c.instrument_id) ? find(c.instrument_id) : c.instrument_id;
      const list = components.get(root) ?? [];
      list.push(c);
      components.set(root, list);
    }
    for (const [, members] of components) {
      if (members.length < 2) continue;
      const combined = members.reduce((s, m) => s + Math.abs(m.approved_weight_pct), 0);
      if (combined > policy.correlation_cluster_cap_pct) {
        const scale = policy.correlation_cluster_cap_pct / combined;
        for (const m of members) {
          m.approved_weight_pct = m.approved_weight_pct * scale;
          if (m.verdict === 'ALLOW') m.verdict = 'REDUCE';
          m.reasons.push(`REDUCE: correlated cluster combined ${combined.toFixed(2)}% > ${policy.correlation_cluster_cap_pct}%`);
          m.decisions.push(mk(m.candidate_id, 'correlation-cluster', combined, policy.correlation_cluster_cap_pct, 'REDUCE', `cluster scaled ${(scale * 100).toFixed(1)}%`));
        }
      }
    }
  }

  // Overall verdict: REJECT > UNKNOWN > REDUCE > ALLOW.
  const rank = { ALLOW: 0, REDUCE: 1, UNKNOWN: 2, REJECT: 3 };
  let overall: RiskVerdictValue = portfolioVerdict;
  for (const c of candidates) {
    if (rank[c.verdict] > rank[overall]) overall = c.verdict;
  }
  const grossPct = input.current.gross_pct + candidates.reduce((s, c) => s + c.approved_weight_pct, 0);
  return { candidates, portfolioVerdict: overall, drawdownState: ddState, portfolioDecisions, grossPct };
}
