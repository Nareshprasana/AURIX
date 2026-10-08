// Valuation Research Agent: ratio arithmetic from validated inputs with explicit
// assumptions, uncertainty bands and a calculation version. No trade orders.
import type { AgentResult, EvidenceItem } from '@aurix/contracts';
import { blankResult, observation, type AgentContext, type ResearchAgent } from '../types.js';

function numOf(e: EvidenceItem[], metric: string): { value: number; evidence: EvidenceItem } | null {
  const hit = e.filter((x) => (x.content as Record<string, unknown>)['metric'] === metric)
    .find((x) => typeof (x.content as Record<string, unknown>)['value'] === 'number');
  return hit ? { value: (hit.content as Record<string, unknown>)['value'] as number, evidence: hit } : null;
}

export class ValuationAgent implements ResearchAgent {
  readonly id = 'valuation';
  readonly topics = ['valuation', 'pe', 'pb', 'ebitda', 'dcf', 'fcf', 'relative', 'multiple'];
  static readonly CALC_VERSION = 'valuation-v1';

  async run(ctx: AgentContext): Promise<AgentResult> {
    const result = blankResult(this.id, ctx.task.task_id, ctx.task.subject, 'COMPLETED', ctx.now);
    result.methodology = 'valuation-v1: trailing ratios from validated inputs; ±20% assumption bands';
    const items = ctx.evidence;
    const price = numOf(items, 'price');
    const eps = numOf(items, 'eps');
    const book = numOf(items, 'book_value');
    const ev = numOf(items, 'ev');
    const ebitda = numOf(items, 'ebitda');
    const fcf = numOf(items, 'fcf');
    const computed: { name: string; value: number; inputs: EvidenceItem[] }[] = [];
    if (price && eps && eps.value !== 0) {
      computed.push({ name: 'P/E', value: price.value / eps.value, inputs: [price.evidence, eps.evidence] });
      result.assumptions.push('P/E uses trailing EPS; no growth adjustment');
    }
    if (price && book && book.value !== 0) {
      computed.push({ name: 'P/B', value: price.value / book.value, inputs: [price.evidence, book.evidence] });
    }
    if (ev && ebitda && ebitda.value !== 0) {
      computed.push({ name: 'EV/EBITDA', value: ev.value / ebitda.value, inputs: [ev.evidence, ebitda.evidence] });
    }
    if (fcf && price && price.value !== 0) {
      computed.push({ name: 'FCF yield', value: fcf.value / price.value, inputs: [fcf.evidence, price.evidence] });
      result.assumptions.push('FCF yield uses last reported FCF; sustainability not assessed');
    }
    if (computed.length === 0) {
      result.status = 'INSUFFICIENT_DATA';
      for (const m of ['price', 'eps', 'book_value', 'ev', 'ebitda', 'fcf']) {
        if (!numOf(items, m)) result.missing.push(`missing input: ${m}`);
      }
      return result;
    }
    for (const c of computed) {
      const low = c.value * 0.8;
      const high = c.value * 1.2;
      result.observations.push(observation(this.id, ctx.task.subject,
        `${c.name} = ${c.value.toFixed(2)} (uncertainty band ${low.toFixed(2)}..${high.toFixed(2)}, ±20% assumption band).`, {
          methodology: 'valuation-v1 ratio',
          metric: c.name,
          value: c.value,
          inputs_ref: c.inputs.map((e) => e.evidence_id),
          data_quality: 'VALID',
          confidence: 0.6
        }));
      result.evidence.push(...c.inputs);
    }
    result.sources = [...new Set(items.map((e) => e.source))];
    result.conclusions.push(`Valuation range computed from ${computed.length} ratio(s) (${ValuationAgent.CALC_VERSION}); bands express assumption uncertainty, not precision.`);
    result.confidence = computed.length >= 2 ? 0.65 : 0.5;
    if (computed.length === 1) result.status = 'PARTIAL';
    result.knowledge_proposals.push({
      assertion: 'OBSERVATION',
      summary: `valuation observations for ${ctx.task.subject} (${computed.map((c) => c.name).join(', ')})`,
      entity_refs: [ctx.task.subject]
    });
    return result;
  }
}
