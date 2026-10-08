// Event Intelligence Agent: structures validated market events into event
// observations, deduplicates repeats, preserves contradictory event reports,
// and maps dependency scope for targeted invalidation.
import type { MarketEvent } from '@aurix/market-data';
import type { AgentResult } from '@aurix/contracts';
import { invalidationTopicsFor } from '@aurix/market-data';
import { blankResult, observation, type AgentContext, type ResearchAgent } from '../types.js';

export class EventIntelligenceAgent implements ResearchAgent {
  readonly id = 'events';
  readonly topics = ['event', 'corporate', 'earnings', 'dividend', 'split', 'bonus', 'merger', 'promoter', 'management', 'regulatory', 'macro-event'];

  async run(ctx: AgentContext): Promise<AgentResult> {
    const result = blankResult(this.id, ctx.task.task_id, ctx.task.subject, 'COMPLETED', ctx.now);
    result.methodology = 'events-v1: structure validated events; dedupe repeats; preserve contradictions';
    if (ctx.events.length === 0) {
      result.status = 'INSUFFICIENT_DATA';
      result.missing.push('no market events supplied');
      return result;
    }
    const seen = new Map<string, MarketEvent>();
    for (const event of ctx.events) {
      const prior = seen.get(event.event_id);
      if (prior) {
        if (JSON.stringify(prior.payload) !== JSON.stringify(event.payload)) {
          result.contradictions.push(`event ${event.event_id} reported with differing payloads (${prior.source} vs ${event.source}); both preserved, neither assumed`);
        } else {
          result.assumptions.push(`duplicate delivery of ${event.event_id} ignored`);
        }
        continue;
      }
      seen.set(event.event_id, event);
      const topics = invalidationTopicsFor(event.event_type);
      result.observations.push(observation(this.id, ctx.task.subject,
        `${event.event_type} event ${event.event_id} affecting ${(event.entity_refs).join(', ') || 'unknown entities'} (occurred ${new Date(event.occurred_at).toISOString()}).`, {
          methodology: 'events-v1 structuring',
          value: event.event_type,
          inputs_ref: [event.event_id],
          data_quality: 'VALID',
          confidence: 0.8
        }));
      result.evidence.push({
        evidence_id: `ev-${event.event_id}`,
        kind: 'market-event',
        subject: ctx.task.subject,
        content: { event_id: event.event_id, event_type: event.event_type, topics, payload: event.payload },
        source: event.source,
        source_type: 'press',
        source_identifier: event.event_id,
        observed_at: event.occurred_at,
        retrieved_at: event.received_at,
        confidence: 0.8
      });
    }
    result.sources = [...new Set(ctx.events.map((e) => e.source))];
    if (result.observations.length === 0) {
      result.status = 'INSUFFICIENT_DATA';
      return result;
    }
    if (result.contradictions.length > 0) result.status = 'CONFLICTED';
    result.conclusions.push(`Event landscape: ${result.observations.length} structured event(s), ${result.contradictions.length} contradiction(s); invalidation scope follows event topics.`);
    result.confidence = result.contradictions.length > 0 ? 0.5 : 0.75;
    result.knowledge_proposals.push({
      assertion: 'OBSERVATION',
      summary: `event intelligence: ${result.observations.length} events for ${ctx.task.subject}`,
      entity_refs: [ctx.task.subject, ...ctx.events.flatMap((e) => e.entity_refs)]
    });
    return result;
  }
}
