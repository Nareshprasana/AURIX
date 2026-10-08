// Research context assembly: minimal, redacted, ACL-aware slices for agents.
// Never the whole graph or memory database: task + redacted relevant memories +
// filtered evidence + recent events + VALID market observations + gaps.
import type { EvidenceItem } from '@aurix/contracts';
import type { CanonicalBar, CanonicalQuote, MarketEvent } from '@aurix/market-data';
import { assessBar, assessQuote } from '@aurix/market-data';
import { MemoryManager } from '@aurix/memory-manager';
import { redact } from '@aurix/observability';
import type { AgentContext, Interpreter } from './types.js';

export interface ResearchContextRequest {
  taskId: string;
  subject: string;
  topic?: string;
  agent: string;
  evidence?: EvidenceItem[];
  bars?: CanonicalBar[];
  quotes?: CanonicalQuote[];
  events?: MarketEvent[];
  interpreter?: Interpreter;
  llmRequired?: boolean;
  memoryLimit?: number;
  now?: number;
}

export async function buildResearchContext(
  memory: MemoryManager,
  req: ResearchContextRequest
): Promise<AgentContext> {
  const now = req.now ?? Date.now();
  // Entity-scoped, redacted memory slice (topic focuses agents downstream, never blinds retrieval).
  const memories = memory.retrieve({ entity: req.subject, requester: req.agent, limit: req.memoryLimit ?? 20 }, now)
    .map((h) => redact(h.record));
  const gaps = memory.gapReport(req.subject, [{ topic: req.topic ?? '*', entity_ids: [req.subject], memory_keys: [] }], now, req.agent);
  const qualityNotes: string[] = [];
  const validBars: CanonicalBar[] = [];
  if (req.bars) {
    const seen = new Set<string>();
    let lastTs = 0;
    for (const bar of [...req.bars].sort((a, b) => a.ts - b.ts)) {
      const report = assessBar(bar, { now, lastTs: lastTs || undefined, seenIds: seen });
      if (report.verdict === 'VALID') {
        validBars.push(bar);
        seen.add(`${bar.instrument_id}|${bar.ts}|${bar.provider}`);
        lastTs = bar.ts;
      } else {
        qualityNotes.push(`bar@${bar.ts} excluded: ${report.verdict} (${report.reasons.join('; ')})`);
      }
    }
  }
  const validQuotes: CanonicalQuote[] = [];
  if (req.quotes) {
    for (const quote of req.quotes) {
      const report = assessQuote(quote, { now });
      if (report.verdict === 'VALID') validQuotes.push(quote);
      else qualityNotes.push(`quote@${quote.ts} excluded: ${report.verdict} (${report.reasons.join('; ')})`);
    }
  }
  return {
    task: { task_id: req.taskId, subject: req.subject, objective: req.topic ?? 'general', scope: 'research', agent: req.agent },
    memories,
    evidence: req.evidence ?? [],
    events: req.events ?? [],
    bars: validBars,
    quotes: validQuotes,
    gaps: gaps.map((g) => ({ topic: g.topic, status: g.status })),
    qualityNotes,
    interpreter: req.interpreter,
    llmRequired: req.llmRequired,
    now
  };
}
