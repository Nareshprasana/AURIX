// Fundamental Research Agent: consumes validated metric evidence, computes
// period-over-period growth deterministically, preserves contradictions, never
// invents data. Conclusions are inferences; FACT status is left to store policy.
import type { AgentResult, EvidenceItem } from '@aurix/contracts';
import { blankResult, observation, type AgentContext, type ResearchAgent } from '../types.js';

interface MetricPoint {
  metric: string;
  value: number;
  period: string;
  evidence: EvidenceItem;
}

function metricEvidence(ctx: AgentContext): EvidenceItem[] {
  return ctx.evidence.filter((e) => (e.content as Record<string, unknown>)['metric'] !== undefined);
}

function groupByMetric(items: EvidenceItem[]): Map<string, MetricPoint[]> {
  const groups = new Map<string, MetricPoint[]>();
  for (const e of items) {
    const c = e.content as Record<string, unknown>;
    if (typeof c['value'] !== 'number' || typeof c['metric'] !== 'string') continue;
    const list = groups.get(c['metric'] as string) ?? [];
    list.push({ metric: c['metric'] as string, value: c['value'] as number, period: typeof c['period'] === 'string' ? c['period'] : 'unknown', evidence: e });
    groups.set(c['metric'] as string, list);
  }
  for (const list of groups.values()) list.sort((a, b) => (a.period < b.period ? -1 : 1));
  return groups;
}

export class FundamentalAgent implements ResearchAgent {
  readonly id = 'fundamental';
  readonly topics = ['fundamental', 'earnings', 'revenue', 'profit', 'margins', 'debt', 'filings', 'financials', 'growth', 'management'];

  async run(ctx: AgentContext): Promise<AgentResult> {
    const result = blankResult(this.id, ctx.task.task_id, ctx.task.subject, 'COMPLETED', ctx.now);
    result.methodology = 'fundamental-v1: period-over-period growth on validated metric evidence; contradictions preserved';
    const items = metricEvidence(ctx);
    if (items.length === 0) {
      result.status = 'INSUFFICIENT_DATA';
      result.missing.push('no financial-metric evidence supplied');
      return result;
    }
    const groups = groupByMetric(items);
    let usable = 0;
    for (const [metric, points] of groups) {
      // Same metric + same period, different values → contradiction (possible causes stated, none invented).
      const byPeriod = new Map<string, MetricPoint[]>();
      for (const p of points) {
        const list = byPeriod.get(p.period) ?? [];
        list.push(p);
        byPeriod.set(p.period, list);
      }
      for (const [period, list] of byPeriod) {
        const values = new Set(list.map((p) => p.value));
        if (values.size > 1) {
          result.contradictions.push(
            `${metric} ${period}: conflicting values ${[...values].join(' vs ')} from ${list.map((p) => p.evidence.source_identifier).join(', ')} (possible: different periods, reporting basis, revision, scope difference)`
          );
        }
      }
      const canonical = [...byPeriod.entries()].map(([period, list]) => ({ period, value: list[0]!.value, evidence: list[0]!.evidence }));
      for (let i = 1; i < canonical.length; i++) {
        const prev = canonical[i - 1]!;
        const cur = canonical[i]!;
        const growth = prev.value !== 0 ? (cur.value - prev.value) / Math.abs(prev.value) : 0;
        usable++;
        result.observations.push(observation(this.id, ctx.task.subject,
          `${metric} moved from ${prev.value} (${prev.period}) to ${cur.value} (${cur.period}).`, {
            methodology: 'fundamental-v1 growth',
            metric,
            value: growth,
            period: cur.period,
            inputs_ref: [prev.evidence.evidence_id, cur.evidence.evidence_id],
            data_quality: 'VALID',
            confidence: 0.85
          }));
        result.evidence.push(prev.evidence, cur.evidence);
      }
      if (canonical.length === 1) {
        result.observations.push(observation(this.id, ctx.task.subject,
          `${metric} reported as ${canonical[0]!.value} for ${canonical[0]!.period} (single period, no growth computable).`, {
            methodology: 'fundamental-v1 single-point',
            metric,
            value: canonical[0]!.value,
            period: canonical[0]!.period,
            inputs_ref: [canonical[0]!.evidence.evidence_id],
            data_quality: 'VALID',
            confidence: 0.7
          }));
        usable++;
      }
    }
    result.sources = [...new Set(items.map((e) => e.source))];
    if (usable === 0) {
      result.status = 'INSUFFICIENT_DATA';
      result.missing.push('no usable numeric metric evidence');
      return result;
    }
    const growthObs = result.observations.filter((o) => typeof o.value === 'number');
    if (growthObs.length > 0) {
      const avg = growthObs.reduce((s, o) => s + (o.value as number), 0) / growthObs.length;
      result.conclusions.push(`Growth momentum appears ${avg >= 0 ? 'stronger' : 'weaker'} on average (${(avg * 100).toFixed(1)}% mean period change; inference, not fact).`);
    }
    result.confidence = result.contradictions.length > 0 ? 0.5 : 0.75;
    if (ctx.interpreter && !result.contradictions.length) {
      try {
        const r = await ctx.interpreter.interpret('fundamental-summary', result.observations.map((o) => o.statement).join(' '));
        result.conclusions.push(`LLM interpretation (${r.model}, inference): ${r.text}`);
        result.assumptions.push(`llm-model:${r.model}`);
      } catch {
        result.assumptions.push('LLM interpretation unavailable; deterministic core stands');
      }
    } else if (ctx.llmRequired && !ctx.interpreter) {
      result.status = 'MODEL_UNAVAILABLE';
      result.missing.push('interpreter required but not provided');
    }
    result.knowledge_proposals.push({
      assertion: 'OBSERVATION',
      summary: `fundamental observations for ${ctx.task.subject} (${result.observations.length} obs, ${result.contradictions.length} contradictions)`,
      entity_refs: [ctx.task.subject]
    });
    return result;
  }
}
