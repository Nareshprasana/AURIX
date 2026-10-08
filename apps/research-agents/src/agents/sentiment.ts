// Sentiment Research Agent: lexicon classification per source, near-duplicate
// grouping (counted once), aggregate inference. Sentiment is never FACT.
import type { AgentResult, EvidenceItem } from '@aurix/contracts';
import { filterEvidence } from '../sources.js';
import { blankResult, observation, type AgentContext, type ResearchAgent } from '../types.js';

const POSITIVE = ['growth', 'profit', 'record', 'upgrade', 'strong', 'beat', 'beats', 'bullish', 'optimistic', 'surge', 'rally', 'outperform', 'robust', 'recovery', 'dividend', 'buyback', 'expansion'];
const NEGATIVE = ['loss', 'downgrade', 'weak', 'miss', 'bearish', 'pessimistic', 'plunge', 'slump', 'fraud', 'probe', 'penalty', 'cut', 'layoff', 'default', 'selloff', 'concern', 'risk', 'fall', 'decline'];

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
}

function textOf(e: EvidenceItem): string {
  const c = e.content as Record<string, unknown>;
  return [c['title'], c['text'], c['headline']].filter((v) => typeof v === 'string').join(' ');
}

export function classifySentiment(text: string): { label: 'positive' | 'negative' | 'neutral'; pos: number; neg: number } {
  const tokens = tokenize(text);
  let pos = 0;
  let neg = 0;
  for (const t of tokens) {
    if (POSITIVE.includes(t)) pos++;
    if (NEGATIVE.includes(t)) neg++;
  }
  if (pos === 0 && neg === 0) return { label: 'neutral', pos, neg };
  if (pos > neg) return { label: 'positive', pos, neg };
  if (neg > pos) return { label: 'negative', pos, neg };
  return { label: 'neutral', pos, neg };
}

export class SentimentAgent implements ResearchAgent {
  readonly id = 'sentiment';
  readonly topics = ['sentiment', 'news', 'mood', 'commentary', 'statements'];

  async run(ctx: AgentContext): Promise<AgentResult> {
    const result = blankResult(this.id, ctx.task.task_id, ctx.task.subject, 'COMPLETED', ctx.now);
    result.methodology = 'sentiment-v1: lexicon counts per source; near-duplicates grouped and counted once';
    const texts = ctx.evidence.filter((e) => typeof (e.content as Record<string, unknown>)['text'] === 'string' || typeof (e.content as Record<string, unknown>)['title'] === 'string');
    if (texts.length === 0) {
      result.status = 'INSUFFICIENT_DATA';
      result.missing.push('no text-bearing evidence supplied');
      return result;
    }
    const filtered = filterEvidence(texts);
    for (const d of filtered.droppedLowAuthority) {
      result.assumptions.push(`excluded low-authority source ${d.source_identifier}`);
    }
    let pos = 0;
    let neg = 0;
    let neutral = 0;
    for (const item of filtered.kept) {
      const text = textOf(item);
      const cls = classifySentiment(text);
      if (cls.label === 'positive') pos++;
      else if (cls.label === 'negative') neg++;
      else neutral++;
      result.observations.push(observation(this.id, ctx.task.subject,
        `Source ${item.source_identifier} sentiment = ${cls.label} (${cls.pos} positive vs ${cls.neg} negative hits).`, {
          methodology: 'sentiment-v1 lexicon',
          value: cls.label,
          inputs_ref: [item.evidence_id],
          data_quality: 'VALID',
          confidence: 0.55
        }));
      result.evidence.push(item);
    }
    for (const g of filtered.duplicateGroups) {
      result.assumptions.push(`grouped ${g.duplicates.length} near-duplicate(s) of ${g.canonical.source_identifier} (Jaccard ≥ threshold; counted once)`);
    }
    result.sources = [...new Set(filtered.kept.map((e) => e.source))];
    const total = pos + neg + neutral;
    const lean = pos > neg ? 'positive' : neg > pos ? 'negative' : 'mixed/neutral';
    result.conclusions.push(`Short-term sentiment appears ${lean} across ${total} unique source(s) (${pos}+/${neg}-/${neutral}=); inference from text signals, not fact.`);
    result.confidence = total > 0 ? 0.55 : 0.3;
    result.knowledge_proposals.push({
      assertion: 'INFERENCE',
      summary: `sentiment inference for ${ctx.task.subject}: ${lean} (${total} sources)`,
      entity_refs: [ctx.task.subject]
    });
    return result;
  }
}
