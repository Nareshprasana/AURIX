// Portfolio service: candidates → construction → allocation → risk → rebalance
// → hypothetical decision → persist. Pipeline only: no broker, no execution,
// no live state. Risk verdicts are final; REJECT/UNKNOWN candidates never trade.
import type {
  AllocationMethod,
  MarketSnapshot,
  PipelineRequest,
  PortfolioCandidate,
  PortfolioDecision,
  PortfolioState,
  PositionView,
  RiskDecision
} from '@aurix/portfolio';
import {
  applyTurnoverBudget,
  buildCapital,
  buildSnapshot,
  computeExposure,
  concentration,
  diffRebalance,
  drawdownState,
  evaluatePortfolioRisk,
  finalizeSize,
  markToMarket,
  PHASE1_DEFAULTS,
  sectorExposure,
  sizeFixedFraction,
  sizeLiquidityConstrained,
  sizeVolatilityTarget,
  summarizeDecision
} from '@aurix/portfolio';
import type { AllocationInputs } from '@aurix/portfolio';
import { ALLOCATORS } from '@aurix/portfolio';
import { KnowledgeStore, cyrb53hex, stableStringify } from '@aurix/knowledge-service';
import { MemoryManager } from '@aurix/memory-manager';

export interface PipelineResult {
  decision: PortfolioDecision;
  state: PortfolioState;
  flow: 'COMPLETED' | 'PARTIAL' | 'RISK_BLOCKED' | 'NO_TRADE' | 'INSUFFICIENT_DATA' | 'DATA_QUARANTINED' | 'FAILED';
  target_positions: PositionView[];
}

export const PORTFOLIO_CODE_VERSION = 'portfolio-v1';

export class PortfolioService {
  constructor(
    private knowledge: KnowledgeStore,
    private memory: MemoryManager
  ) {}

  construct(req: PipelineRequest): PipelineResult {
    const now = req.now ?? Date.now();
    const empty = (flow: PipelineResult['flow'], reason: string): PipelineResult => ({
      decision: this.noTradeDecision(req, [], [], reason, now),
      state: this.emptyState(req, now),
      flow,
      target_positions: []
    });
    if (req.candidates.length === 0) return empty('NO_TRADE', 'no candidates supplied');
    const decisionId = `pdec-${cyrb53hex(stableStringify([req.portfolio_id, req.candidates.map((c) => c.candidate_id).sort(), req.market.as_of, req.capital.total]))}`;
    // 1. Allocation (deterministic weights, bounded).
    const method = req.allocation ?? 'hybrid';
    const allocator = ALLOCATORS[method];
    const allocation = allocator(req.candidates, {
      maxWeightPct: PHASE1_DEFAULTS.max_position_pct,
      volatilities: req.market.volatilities as Record<string, number>,
      liquidityScores: Object.fromEntries(req.candidates.map((c) => [c.instrument.instrument_id, 0.5])),
      ...(req.allocationInputs ?? {})
    });
    // 2. Risk evaluation (veto authority; UNKNOWN fail-safe).
    // Market snapshot is the fresh authority: refresh candidate liquidity from it
    // (signal-time values stay on the record for audit, risk uses current data).
    // Current-book concentration/leverage derive from actual positions (margin
    // assumed 0 absent broker margin data — recorded assumption, never live data).
    const riskCandidates = req.candidates.map((c) => ({
      candidate: {
        ...c,
        liquidity: {
          adv_value: req.market.adv[c.instrument.instrument_id] ?? null,
          spread_bps: req.market.spreads_bps[c.instrument.instrument_id] ?? null,
          volume: req.market.volumes[c.instrument.instrument_id] ?? null
        }
      }
    }));
    const equity = req.capital.total;
    const currentExposure = computeExposure(req.current, equity);
    const currentSectors = sectorExposure(req.current, req.market.sectors);
    const sectorPct: Record<string, number> = {};
    for (const [s, v] of Object.entries(currentSectors.bySector)) {
      const total = req.current.reduce((sum, p) => sum + Math.abs(p.market_value), 0);
      sectorPct[s] = total > 0 ? (v / total) * 100 : 0;
    }
    const currentConc = concentration(req.current);
    const risk = evaluatePortfolioRisk({
      portfolio_id: req.portfolio_id,
      candidates: riskCandidates.map((c) => ({
        candidate: c.candidate,
        weight_pct: allocation.weights[c.candidate.instrument.instrument_id] ?? 0,
        sector: req.market.sectors[c.candidate.instrument.instrument_id] ?? null,
        equity,
        price: req.market.prices[c.candidate.instrument.instrument_id] ?? null,
        strategyAuthorized: req.strategyAuth?.[c.candidate.strategy_id] ?? true,
        modeAllowsOrders: req.modeAllowsOrders ?? true
      })),
      current: {
        gross_pct: currentExposure.gross_pct,
        sector_pct: sectorPct,
        top5_pct: currentConc.top5_pct,
        leverage: equity > 0 ? currentExposure.gross / equity : 1.0,
        margin_pct: 0,
        daily_loss_pct: req.daily_pnl_override ?? 0,
        drawdown_pct: req.drawdown_override ?? 0
      },
      market: { abnormal: false, haltedIds: [] },
      quality: req.market.quality,
      correlations: req.correlations,
      trace_id: req.trace_id
    }, PHASE1_DEFAULTS, now);
    const ddState = drawdownState(req.drawdown_override ?? 0, req.daily_pnl_override ?? 0, PHASE1_DEFAULTS);
    const approved: Record<string, number> = {};
    const reduced: { instrument_id: string; from_qty: number; to_qty: number; rule_id: string }[] = [];
    const rejected: { instrument_id: string; rule_id: string; reason: string }[] = [];
    const allDecisions: RiskDecision[] = [...risk.portfolioDecisions];

    // 3. Approved weights → sized quantities (risk caps bind sizing).
    // Portfolio-level REJECT/UNKNOWN vetoes everything, even individually-ALLOW candidates.
    const blockedIds = new Set<string>();
    if (risk.portfolioVerdict === 'REJECT' || risk.portfolioVerdict === 'UNKNOWN') {
      for (const v of risk.candidates) {
        if (v.verdict === 'ALLOW' || v.verdict === 'REDUCE') {
          rejected.push({ instrument_id: v.instrument_id, rule_id: 'portfolio-gate', reason: `blocked by portfolio verdict ${risk.portfolioVerdict}` });
          blockedIds.add(v.instrument_id);
        }
      }
    }
    const refreshedById = new Map(riskCandidates.map((w) => [w.candidate.candidate_id, w.candidate]));
    for (const v of risk.candidates) {
      if (blockedIds.has(v.instrument_id)) continue;
      allDecisions.push(...v.decisions);
      if (v.verdict === 'REJECT' || v.verdict === 'UNKNOWN') {
        rejected.push({ instrument_id: v.instrument_id, rule_id: v.decisions[v.decisions.length - 1]?.rule_id ?? 'risk', reason: v.reasons.join('; ') });
        continue;
      }
      const cand = refreshedById.get(v.candidate_id)!;
      const price = req.market.prices[v.instrument_id] ?? 0;
      const riskNotional = (v.approved_weight_pct / 100) * equity;
      const sized = finalizeSize([
        sizeFixedFraction({ instrument_id: v.instrument_id, weight_pct: v.approved_weight_pct, equity, price }, 2),
        sizeVolatilityTarget({ instrument_id: v.instrument_id, weight_pct: v.approved_weight_pct, equity, price, volatility: req.market.volatilities[v.instrument_id] ?? null }),
        sizeLiquidityConstrained({ instrument_id: v.instrument_id, weight_pct: v.approved_weight_pct, equity, price, adv_value: cand.liquidity.adv_value })
      ], riskNotional, price);
      if (sized.qty <= 0) {
        rejected.push({ instrument_id: v.instrument_id, rule_id: 'sizing-zero', reason: sized.explanation });
        continue;
      }
      approved[v.instrument_id] = sized.qty * cand.direction;
      if (v.verdict === 'REDUCE') {
        reduced.push({ instrument_id: v.instrument_id, from_qty: 0, to_qty: sized.qty, rule_id: v.decisions.find((d) => d.decision === 'REDUCE')?.rule_id ?? 'risk' });
      }
    }

    // 4. Rebalance current → target with turnover budget.
    const targets: Record<string, number> = {};
    for (const p of req.current) targets[p.instrument_id] = p.qty;
    for (const [id, qty] of Object.entries(approved)) targets[id] = qty;
    for (const r of rejected) {
      if (!(r.instrument_id in approved)) targets[r.instrument_id] = req.current.find((p) => p.instrument_id === r.instrument_id)?.qty ?? 0;
    }
    const prices: Record<string, number> = req.market.prices;
    const diff = diffRebalance({ current: req.current, targets, prices, turnoverBudgetPct: req.turnoverBudgetPct ?? 25, equity, cost_model: { brokerage_bps: 5, exchange_bps: 2, taxes_bps: 3, min_cost: 0, per_side: true } });
    const budgeted = applyTurnoverBudget(diff.lines, prices, equity, req.turnoverBudgetPct ?? 25);
    const blocked = new Set(rejected.map((r) => r.instrument_id));
    const lines = budgeted.lines.map((l) => blocked.has(l.instrument_id) && l.delta_qty !== 0
      ? { ...l, target_qty: l.current_qty, delta_qty: 0, intent: 'BLOCKED' as const, est_cost: 0, reason: 'risk rejected/unknown' }
      : l);

    // 5. Target positions + mark + decision.
    const target_positions: PositionView[] = lines
      .filter((l) => l.target_qty !== 0)
      .map((l) => {
        const cand = req.candidates.find((c) => c.instrument.instrument_id === l.instrument_id);
        const price = prices[l.instrument_id] ?? 0;
        const cur = req.current.find((p) => p.instrument_id === l.instrument_id);
        return {
          position_id: `pos-${req.portfolio_id}-${l.instrument_id}`,
          instrument_id: l.instrument_id,
          qty: Math.abs(l.target_qty),
          side: (l.target_qty > 0 ? 1 : l.target_qty < 0 ? -1 : 0) as 1 | -1 | 0,
          avg_price: cur?.avg_price ?? price,
          mark_price: price,
          market_value: Math.abs(l.target_qty) * price,
          weight_pct: equity > 0 ? (Math.abs(l.target_qty) * price) / equity * 100 : 0,
          realized_pnl: cur?.realized_pnl ?? 0,
          unrealized_pnl: 0,
          strategy_id: cand?.strategy_id ?? cur?.strategy_id ?? '',
          strategy_version: cand?.strategy_version ?? cur?.strategy_version ?? 0,
          sector: req.market.sectors[l.instrument_id] ?? cur?.sector ?? null,
          asset_class: cur?.asset_class ?? 'equity',
          liquidity: { adv_value: cand?.liquidity.adv_value ?? null, spread_bps: cand?.liquidity.spread_bps ?? null },
          updated_at: now
        };
      });
    const marked = markToMarket(target_positions, prices, req.prev_equity, req.peak_equity, equity);
    const invested = marked.positions.reduce((s, p) => s + Math.abs(p.market_value), 0);
    const capital = buildCapital({ total: req.capital.total, reserved_pct: 0, base_currency: req.capital.base_currency }, invested, 0);
    const exposure = computeExposure(marked.positions, equity);
    capital.gross_exposure = exposure.gross;
    capital.net_exposure = exposure.net;
    const state = {
      portfolio_id: req.portfolio_id,
      version: 1,
      capital,
      positions: marked.positions,
      realized_pnl: marked.realized_pnl,
      unrealized_pnl: marked.unrealized_pnl,
      drawdown_pct: marked.drawdown_pct,
      peak_equity: marked.peak_equity,
      daily_pnl_pct: marked.daily_pnl_pct,
      drawdown_state: ddState,
      status: ddState === 'HALTED' ? 'HALTED' : 'ACTIVE',
      updated_at: now,
      provenance: { source: 'portfolio-service', source_type: 'agent' as const, evidence_refs: req.candidates.map((c) => c.candidate_id) }
    };
    const versions = {
      strategy: req.candidates.map((c) => `${c.strategy_id}:v${c.strategy_version}`).sort().join(','),
      config: 'portfolio-policy-v1',
      risk: PHASE1_DEFAULTS.version,
      allocator: `${method}-v1`,
      code: PORTFOLIO_CODE_VERSION,
      dataset: String(req.market.as_of)
    };
    const decision = summarizeDecision({
      decision_id: decisionId,
      timestamp: now,
      portfolio_id: req.portfolio_id,
      portfolio_version: 1,
      candidates: req.candidates.map((c) => c.candidate_id),
      proposed: Object.fromEntries(req.candidates.map((c) => [c.instrument.instrument_id, allocation.weights[c.instrument.instrument_id] ?? 0])),
      approved: Object.fromEntries(Object.entries(approved).map(([id, qty]) => [id, qty])),
      reduced,
      rejected,
      risk_decisions: allDecisions,
      positions: marked.positions,
      equity,
      expected_turnover: budgeted.turnover_pct,
      estimated_costs: budgeted.lines.reduce((s, l) => s + l.est_cost, 0),
      assumptions: [...allocation.explanation, 'current-book margin assumed 0 (no broker margin data in Phase 7)', ...(risk.portfolioVerdict === 'REDUCE' ? ['gross scaling applied'] : [])],
      evidence_refs: req.candidates.flatMap((c) => c.evidence_refs),
      versions
    });
    // Persist: knowledge observation + portfolio memory (idempotent by decision id).
    this.persist(req, decision, state, now);
    const finalFlow = decision.outcome === 'NO_TRADE' ? 'NO_TRADE' : decision.outcome === 'RISK_BLOCKED' ? 'RISK_BLOCKED' : budgeted.deferred.length > 0 ? 'PARTIAL' : 'COMPLETED';
    return { decision, state: buildSnapshot(state), flow: finalFlow as PipelineResult['flow'], target_positions: target_positions.map((p) => ({ ...p })) };
  }

  /** Scoped invalidation: only candidates touching event entities are dropped. */
  invalidateCandidates(candidates: PortfolioCandidate[], eventEntityRefs: string[]): { kept: PortfolioCandidate[]; dropped: { candidate_id: string; reason: string }[] } {
    const refs = new Set(eventEntityRefs);
    const kept: PortfolioCandidate[] = [];
    const dropped: { candidate_id: string; reason: string }[] = [];
    for (const c of candidates) {
      const touches = c.invalidation.some((r) => refs.has(r)) || refs.has(c.instrument.instrument_id);
      if (touches) dropped.push({ candidate_id: c.candidate_id, reason: `invalidated by event refs ${[...refs].join(',')}` });
      else kept.push(c);
    }
    return { kept, dropped };
  }

  private noTradeDecision(req: PipelineRequest, riskDecisions: RiskDecision[], rejected: PortfolioDecision['rejected'], reason: string, now: number): PortfolioDecision {
    return summarizeDecision({
      decision_id: `pdec-${cyrb53hex(stableStringify([req.portfolio_id, 'no-trade', req.market.as_of]))}`,
      timestamp: now,
      portfolio_id: req.portfolio_id,
      portfolio_version: 1,
      candidates: req.candidates.map((c) => c.candidate_id),
      proposed: {},
      approved: {},
      reduced: [],
      rejected,
      risk_decisions: riskDecisions,
      positions: req.current,
      equity: req.capital.total,
      expected_turnover: 0,
      estimated_costs: 0,
      assumptions: [reason],
      evidence_refs: [],
      versions: { config: 'portfolio-policy-v1', code: PORTFOLIO_CODE_VERSION }
    });
  }

  private emptyState(req: PipelineRequest, now: number): PortfolioState {
    const capital = buildCapital({ total: req.capital.total, reserved_pct: 0, base_currency: req.capital.base_currency }, 0, 0);
    return {
      portfolio_id: req.portfolio_id, version: 1, capital, positions: [],
      realized_pnl: 0, unrealized_pnl: 0, drawdown_pct: 0, peak_equity: req.capital.total,
      daily_pnl_pct: 0, drawdown_state: 'NORMAL', status: 'ACTIVE', updated_at: now,
      provenance: { source: 'portfolio-service', source_type: 'agent', evidence_refs: [] }
    };
  }

  private persist(req: PipelineRequest, decision: PortfolioDecision, state: PortfolioState, now: number): void {
    const decisionNodeId = `portfolio-decision:${decision.decision_id}`;
    const evidence = decision.evidence_refs.length > 0
      ? decision.evidence_refs.slice(0, 20)
      : [...decision.candidates, ...decision.risk_decisions.map((d) => d.decision_id)];
    if (!this.knowledge.getEntity(decisionNodeId)) {
      this.knowledge.proposeValidateCommit({
        assertion: 'OBSERVATION',
        ops: [{ op: 'upsert-node', node: { id: decisionNodeId, kind: 'Portfolio', label: `decision ${decision.decision_id}`, data: { ...decision, state_version: state.version } } }],
        provenance: {
          source: 'portfolio-service', source_type: 'agent', source_identifier: decisionNodeId,
          observed_at: now, agent: req.actor, evidence_refs: evidence, confidence: 1
        },
        actor: req.actor
      });
    }
    const memKey = `portfolio:${req.portfolio_id}:${decision.decision_id}`;
    const existing = this.memory.retrieve({ entity: memKey, requester: req.actor }, now);
    if (existing.length === 0) {
      this.knowledge.proposeValidateCommit({
        assertion: 'OBSERVATION',
        ops: [{ op: 'put-memory', memory: { category: 'strategy', key: memKey, content: { entity: req.portfolio_id, topic: 'portfolio-decision', domain: 'research', outcome: decision.outcome, approved: Object.keys(decision.approved).length, rejected: decision.rejected.length, exposure: decision.exposure, versions: decision.versions } } }],
        provenance: {
          source: 'portfolio-service', source_type: 'agent', source_identifier: memKey,
          observed_at: now, agent: req.actor, evidence_refs: [decisionNodeId], confidence: 1
        },
        actor: req.actor
      });
    }
  }
}

export type { AllocationInputs };
