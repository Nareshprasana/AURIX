// Macro Research Agent: indicator observations with period/publication/revision.
// First-published values are never assumed final; revisions version prior rows.
import type { AgentResult, EvidenceItem } from '@aurix/contracts';
import { blankResult, observation, type AgentContext, type ResearchAgent } from '../types.js';

function indicatorEvidence(ctx: AgentContext): EvidenceItem[] {
  return ctx.evidence.filter((e) => typeof (e.content as Record<string, unknown>)['indicator'] === 'string');
}

export class MacroAgent implements ResearchAgent {
  readonly id = 'macro';
  readonly topics = ['macro', 'rates', 'inflation', 'gdp', 'employment', 'currency', 'commodities', 'liquidity', 'central-bank', 'indicators'];

  async run(ctx: AgentContext): Promise<AgentResult> {
    const result = blankResult(this.id, ctx.task.task_id, ctx.task.subject, 'COMPLETED', ctx.now);
    result.methodology = 'macro-v1: indicator readings with publication timestamps; revisions tracked, never assumed final';
    const items = indicatorEvidence(ctx);
    if (items.length === 0) {
      result.status = 'INSUFFICIENT_DATA';
      result.missing.push('no macro-indicator evidence supplied');
      return result;
    }
    for (const item of items) {
      const c = item.content as Record<string, unknown>;
      const indicator = c['indicator'] as string;
      const value = c['value'] as number | string;
      const period = typeof c['period'] === 'string' ? c['period'] : 'unknown';
      const published = typeof c['publication_ts'] === 'number' ? c['publication_ts'] : item.observed_at;
      const revisionOf = typeof c['revision_of'] === 'string' ? c['revision_of'] : null;
      if (value === undefined) {
        result.missing.push(`indicator ${indicator} lacks a value`);
        continue;
      }
      result.observations.push(observation(this.id, ctx.task.subject,
        `${indicator} = ${value} for ${period} (published ${new Date(published).toISOString()}${revisionOf ? `, revises ${revisionOf}` : ''}).`, {
          methodology: 'macro-v1 reading',
          metric: indicator,
          value,
          period,
          inputs_ref: [item.evidence_id],
          data_quality: 'VALID',
          confidence: 0.7
        }));
      result.evidence.push(item);
      if (revisionOf) {
        result.assumptions.push(`reading revises ${revisionOf}; first-published value not treated as final`);
      }
    }
    if (result.observations.length === 0) {
      result.status = 'INSUFFICIENT_DATA';
      return result;
    }
    result.sources = [...new Set(items.map((e) => e.source))];
    result.conclusions.push(`Macro picture assembled from ${result.observations.length} indicator reading(s); readings are point-in-time and revisable.`);
    result.confidence = 0.65;
    result.knowledge_proposals.push({
      assertion: 'OBSERVATION',
      summary: `macro observations (${result.observations.length} readings)`,
      entity_refs: [ctx.task.subject]
    });
    return result;
  }
}
