// Common research contracts. Agents produce observations and conclusions only —
// the output vocabulary contains no executable trade decisions by construction.
// Agents never import the gateway, broker, execution, risk or portfolio code.
import type {
  AgentResult,
  EvidenceItem,
  ResearchObservation,
  ResearchStatus
} from '@aurix/contracts';
import type {
  CanonicalBar,
  CanonicalQuote,
  MarketEvent
} from '@aurix/market-data';
import type { RetrievalHit } from '@aurix/memory-manager';

/** Local interpreter interface: fulfilled by the Model Gateway outside this package. */
export interface Interpreter {
  interpret(prompt: string, input: string): Promise<{ text: string; model: string }>;
}

export interface ResearchTaskRef {
  task_id: string;
  subject: string;
  objective: string;
  scope: string;
  agent: string;
}

export interface AgentContext {
  task: ResearchTaskRef;
  memories: unknown[];
  evidence: EvidenceItem[];
  events: MarketEvent[];
  bars: CanonicalBar[];
  quotes: CanonicalQuote[];
  gaps: { topic: string; status: string }[];
  qualityNotes: string[];
  interpreter?: Interpreter;
  llmRequired?: boolean;
  now: number;
}

export interface ResearchAgent {
  readonly id: string;
  readonly topics: string[];
  run(ctx: AgentContext): Promise<AgentResult>;
}

let obsSeq = 0;
let evSeq = 0;

export function nextObservationId(agent: string): string {
  obsSeq += 1;
  return `obs-${agent}-${obsSeq}`;
}

export function nextEvidenceId(agent: string): string {
  evSeq += 1;
  return `ev-${agent}-${evSeq}`;
}

export function resetAgentSequences(): void {
  obsSeq = 0;
  evSeq = 0;
}

export function blankResult(agent: string, taskId: string, subject: string, status: ResearchStatus, now: number): AgentResult {
  return {
    research_task_id: taskId,
    agent,
    subject,
    status,
    observations: [],
    evidence: [],
    sources: [],
    methodology: '',
    assumptions: [],
    contradictions: [],
    conclusions: [],
    confidence: 0,
    knowledge_proposals: [],
    missing: [],
    created_at: now
  };
}

export function observation(
  agent: string,
  subject: string,
  statement: string,
  extra: Partial<ResearchObservation> & { methodology: string }
): ResearchObservation {
  return {
    observation_id: nextObservationId(agent),
    subject,
    statement,
    methodology: extra.methodology,
    inputs_ref: extra.inputs_ref ?? [],
    data_quality: extra.data_quality ?? 'UNKNOWN',
    confidence: extra.confidence ?? 0.5,
    ...(extra.metric !== undefined ? { metric: extra.metric } : {}),
    ...(extra.value !== undefined ? { value: extra.value } : {}),
    ...(extra.period !== undefined ? { period: extra.period } : {})
  };
}

export type { RetrievalHit };
