// Technical Research Agent: VALID-assessed OHLCV only. Deterministic indicators
// (SMA, ROC, volatility, support/resistance, drawdown) with recorded inputs.
// Produces observations (trend/momentum/volatility), never trade decisions.
import type { CanonicalBar } from '@aurix/market-data';
import type { AgentResult } from '@aurix/contracts';
import { assessBar } from '@aurix/market-data';
import { blankResult, observation, type AgentContext, type ResearchAgent } from '../types.js';

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const slice = values.slice(-n);
  return slice.reduce((s, v) => s + v, 0) / n;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
}

export class TechnicalAgent implements ResearchAgent {
  readonly id = 'technical';
  readonly topics = ['technical', 'price', 'trend', 'momentum', 'volatility', 'volume', 'breakout', 'support', 'resistance', 'drawdown'];

  async run(ctx: AgentContext): Promise<AgentResult> {
    const result = blankResult(this.id, ctx.task.task_id, ctx.task.subject, 'COMPLETED', ctx.now);
    result.methodology = 'technical-v1: SMA5/20, ROC5, return-volatility, rolling support/resistance, drawdown; VALID data only';
    // Defense in depth: re-assess every bar, drop anything not VALID.
    const seen = new Set<string>();
    let lastTs = 0;
    const valid: CanonicalBar[] = [];
    let dropped = 0;
    for (const bar of [...ctx.bars].sort((a, b) => a.ts - b.ts)) {
      const report = assessBar(bar, { now: ctx.now, lastTs: lastTs || undefined, seenIds: seen });
      if (report.verdict !== 'VALID') {
        dropped++;
        continue;
      }
      seen.add(`${bar.instrument_id}|${bar.ts}|${bar.provider}`);
      lastTs = bar.ts;
      valid.push(bar);
    }
    if (dropped > 0) result.assumptions.push(`${dropped} bars failed re-assessment and were excluded`);
    if (valid.length === 0) {
      const quarantinedUpstream = ctx.qualityNotes.some((n) => n.includes('QUARANTINED'));
      result.status = ctx.bars.length === 0 && !quarantinedUpstream ? 'INSUFFICIENT_DATA' : 'DATA_QUARANTINED';
      result.missing.push(ctx.bars.length === 0 && !quarantinedUpstream ? 'no OHLCV bars supplied' : 'all supplied bars failed quality assessment');
      return result;
    }
    const closes = valid.map((b) => b.close);
    const vols = valid.map((b) => b.volume);
    const first = valid[0]!;
    const last = valid[valid.length - 1]!;
    const range = `${new Date(first.ts).toISOString()}..${new Date(last.ts).toISOString()}`;
    const inputs = valid.map((b) => `${b.instrument_id}@${b.ts}`);
    const sma5 = sma(closes, 5);
    const sma20 = sma(closes, 20);
    if (sma5 !== null && sma20 !== null) {
      const trend = last.close > sma20 ? 'bullish' : last.close < sma20 ? 'bearish' : 'neutral';
      result.observations.push(observation(this.id, ctx.task.subject,
        `trend = ${trend} (close ${last.close} vs SMA20 ${sma20.toFixed(2)}; SMA5 ${sma5.toFixed(2)}).`, {
          methodology: 'technical-v1 sma-crossover', value: trend,
          inputs_ref: inputs.slice(-20), data_quality: 'VALID', confidence: 0.7
        }));
    } else {
      result.missing.push('insufficient bars for SMA20 (need 20)');
    }
    if (closes.length >= 6) {
      const roc = (last.close - closes[closes.length - 6]!) / closes[closes.length - 6]!;
      result.observations.push(observation(this.id, ctx.task.subject,
        `momentum = ${roc >= 0.02 ? 'strengthening' : roc <= -0.02 ? 'weakening' : 'flat'} (ROC5 ${(roc * 100).toFixed(2)}%).`, {
          methodology: 'technical-v1 roc5', value: roc,
          inputs_ref: inputs.slice(-6), data_quality: 'VALID', confidence: 0.65
        }));
    }
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i]! / closes[i - 1]!));
    const vol = stdev(rets);
    result.observations.push(observation(this.id, ctx.task.subject,
      `volatility = ${vol > 0.03 ? 'elevated' : vol > 0.01 ? 'moderate' : 'low'} (stdev log-returns ${vol.toFixed(4)} over ${rets.length} bars).`, {
        methodology: 'technical-v1 volatility', value: vol,
        inputs_ref: inputs, data_quality: 'VALID', confidence: 0.7
      }));
    const lows = valid.map((b) => b.low);
    const highs = valid.map((b) => b.high);
    const support = Math.min(...lows);
    const resistance = Math.max(...highs);
    result.observations.push(observation(this.id, ctx.task.subject,
      `support = ${support}, resistance = ${resistance} over ${valid.length} bars (${range}).`, {
        methodology: 'technical-v1 rolling-extremes', value: `${support}/${resistance}`,
        inputs_ref: inputs, data_quality: 'VALID', confidence: 0.6
      }));
    let peak = closes[0]!;
    let maxDd = 0;
    for (const c of closes) {
      peak = Math.max(peak, c);
      maxDd = Math.min(maxDd, (c - peak) / peak);
    }
    result.observations.push(observation(this.id, ctx.task.subject,
      `max drawdown = ${(maxDd * 100).toFixed(2)}% over range.`, {
        methodology: 'technical-v1 drawdown', value: maxDd,
        inputs_ref: inputs, data_quality: 'VALID', confidence: 0.7
      }));
    const avgVol = vols.reduce((s, v) => s + v, 0) / vols.length;
    result.conclusions.push(`Price structure summarized over ${valid.length} VALID bars (${range}); no trade direction implied.`);
    result.confidence = 0.7;
    result.assumptions.push(`average volume ${avgVol.toFixed(0)}; timeframe ${valid[0]!.timeframe}`);
    result.knowledge_proposals.push({
      assertion: 'OBSERVATION',
      summary: `technical observations for ${ctx.task.subject} (${result.observations.length} obs over ${valid.length} bars)`,
      entity_refs: [ctx.task.subject]
    });
    return result;
  }
}
