// ResearchOrchestrator: memory-first, selective, evidence-driven.
// normalize → memory.decide → route → run (selected, timeout-guarded) →
// collect → contradict → assemble → commit (store only) → task-complete → memorize.
import type {
  AgentResult,
  EvidenceItem,
  KnowledgeLabel,
  KnowledgeProposalInput,
  ResearchResultBundle,
  ResearchStatus
} from '@aurix/contracts';
import type { MarketEvent } from '@aurix/market-data';
import { KnowledgeStore, stableStringify } from '@aurix/knowledge-service';
import { MemoryManager } from '@aurix/memory-manager';
import type { CanonicalBar, CanonicalQuote } from '@aurix/market-data';
import { buildResearchContext } from './context.js';
import { filterEvidence, type FilteredEvidence } from './sources.js';
import { containsSecretPayload } from '@aurix/knowledge-service';
import type { AgentContext, Interpreter, ResearchAgent } from './types.js';
import { FundamentalAgent } from './agents/fundamental.js';
import { TechnicalAgent } from './agents/technical.js';
import { ValuationAgent } from './agents/valuation.js';
import { SentimentAgent } from './agents/sentiment.js';
import { MacroAgent } from './agents/macro.js';
import { EventIntelligenceAgent } from './agents/events.js';

const TOPIC_AGENTS: { agent: string; keywords: string[] }[] = [
  { agent: 'fundamental', keywords: ['fundamental', 'earnings', 'revenue', 'profit', 'eps', 'margin', 'debt', 'filing', 'financial', 'growth', 'management'] },
  { agent: 'technical', keywords: ['technical', 'price', 'trend', 'momentum', 'volatility', 'volume', 'breakout', 'support', 'resistance', 'drawdown', 'chart'] },
  { agent: 'valuation', keywords: ['valuation', 'value', 'pe', 'multiple', 'dcf', 'fcf', 'worth', 'relative'] },
  { agent: 'sentiment', keywords: ['sentiment', 'news', 'mood', 'commentary', 'statement', 'press'] },
  { agent: 'macro', keywords: ['macro', 'rates', 'inflation', 'gdp', 'employment', 'currency', 'commodity', 'liquidity', 'central', 'indicator'] },
  { agent: 'events', keywords: ['event', 'corporate', 'dividend', 'split', 'bonus', 'merger', 'promoter', 'announcement'] }
];

export function selectAgents(text: string, available: ResearchAgent[]): ResearchAgent[] {
  const tokens = text.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const picked: ResearchAgent[] = [];
  // Explicit agent reference by id (custom/injected agents).
  for (const a of available) {
    if (tokens.includes(a.id) && !picked.includes(a)) picked.push(a);
  }
  for (const entry of TOPIC_AGENTS) {
    if (entry.keywords.some((k) => tokens.includes(k))) {
      const agent = available.find((a) => a.id === entry.agent);
      if (agent && !picked.includes(agent)) picked.push(agent);
    }
  }
  return picked;
}

export interface ResearchRequest {
  subject: string;
  objective: string;
  scope?: string;
  topics?: string[];
  agent: string;
  actor: string;
  evidence?: EvidenceItem[];
  bars?: CanonicalBar[];
  quotes?: CanonicalQuote[];
  events?: MarketEvent[];
  interpreter?: Interpreter;
  timeoutMs?: number;
  now?: number;
}

export interface InvestigationOutcome {
  path: 'REUSE' | 'RESEARCH' | 'REFRESH' | 'CONFLICT' | 'INSUFFICIENT';
  status: ResearchStatus;
  bundle: ResearchResultBundle | null;
  task_id: string;
  agentsRun: string[];
  basis: string[];
}

function failedResult(agent: string, taskId: string, subject: string, status: ResearchStatus, now: number, note: string): AgentResult {
  return {
    research_task_id: taskId, agent, subject, status,
    observations: [], evidence: [], sources: [], methodology: '', assumptions: [],
    contradictions: [], conclusions: [], confidence: 0, knowledge_proposals: [],
    missing: [note], created_at: now
  };
}

export class ResearchOrchestrator {
  private agents: ResearchAgent[];
  constructor(
    private knowledge: KnowledgeStore,
    private memory: MemoryManager,
    agents?: ResearchAgent[],
    private timeoutMs = 5000
  ) {
    this.agents = agents ?? [
      new FundamentalAgent(), new TechnicalAgent(), new ValuationAgent(),
      new SentimentAgent(), new MacroAgent(), new EventIntelligenceAgent()
    ];
  }

  async investigate(req: ResearchRequest): Promise<InvestigationOutcome> {
    const now = req.now ?? Date.now();
    const scope = req.scope ?? 'general';
    const decision = this.memory.decide({ subject: req.subject, topic: req.objective, agent: req.agent, now });
    if (decision.decision === 'REUSE') {
      const bundle = this.loadCachedBundle(req.subject, req.objective);
      if (bundle) {
        const task = this.memory.findTasks({ subject: req.subject }).filter((t) => t.objective === req.objective && t.status === 'COMPLETED').pop();
        return { path: 'REUSE', status: bundle.status, bundle, task_id: task?.task_id ?? '', agentsRun: [], basis: decision.basis };
      }
    }
    if (decision.decision === 'CONFLICT' && !this.hasNewEvidence(req)) {
      return { path: 'CONFLICT', status: 'CONFLICTED', bundle: null, task_id: '', agentsRun: [], basis: decision.basis };
    }
    // Register (dedup-aware) then run selected agents.
    const reg = this.memory.registerTask({ subject: req.subject, objective: req.objective, scope, agent: req.agent, actor: req.actor, now });
    const taskId = reg.task.task_id;
    const selected = selectAgents([req.objective, scope, ...(req.topics ?? [])].join(' '), this.agents);
    if (selected.length === 0) {
      this.memory.completeTask(taskId, '', 'FAILED', req.actor, now);
      return { path: 'INSUFFICIENT', status: 'INSUFFICIENT_DATA', bundle: null, task_id: taskId, agentsRun: [], basis: ['no research agent matches the requested topics'] };
    }
    const intake = this.intakeEvidence(req.evidence ?? []);
    const ctx = await buildResearchContext(this.memory, {
      taskId, subject: req.subject, topic: req.objective, agent: req.agent,
      evidence: intake.kept,
      bars: req.bars, quotes: req.quotes, events: req.events,
      interpreter: req.interpreter, now
    });
    const results: AgentResult[] = [];
    for (const agent of selected) {
      results.push(await this.runGuarded(agent, ctx, req.timeoutMs ?? this.timeoutMs, now));
    }
    const contradictions = this.crossContradictions(results);
    const bundle = this.assemble(req, taskId, results, contradictions,
      [...intake.droppedLowAuthority.map((d) => d.evidence_id), ...intake.rejectedSecrets.map((d) => d.evidence_id)], now);
    // Commit through the Knowledge Service only. Agents cannot assert FACT:
    // orchestrator coerces agent FACT suggestions to INFERENCE with a note.
    const knowledgeRefs = this.commitBundle(req, bundle, now);
    bundle.knowledge_refs = knowledgeRefs;
    const completed = this.memory.completeTask(taskId, `node:research:${taskId}`, 'COMPLETED', req.actor, now);
    // Supersede prior completed runs of the same task key: history stays, live claims move on.
    for (const old of this.memory.findTasks({ subject: req.subject })) {
      if (old.task_id !== taskId && old.status === 'COMPLETED' && old.task_key === completed.task_key) {
        this.memory.completeTask(old.task_id, old.result_reference ?? '', 'SUPERSEDED', req.actor, now);
      }
    }
    this.memory.recordAgentMemory({
      agent: req.agent, task_id: taskId, actions: results.map((r) => `${r.agent}:${r.status}`),
      sources: [...new Set(results.flatMap((r) => r.sources))],
      conclusions: bundle.conclusion ? [bundle.conclusion] : [],
      confidence: bundle.confidence, failures: results.filter((r) => r.status === 'FAILED' || r.status === 'TIMEOUT').map((r) => `${r.agent}:${r.status}`),
      lessons: contradictions.length > 0 ? 'contradictions preserved, not resolved' : 'none',
      knowledge_version: this.knowledge.knowledgeVersion(),
      entity: req.subject, topic: req.objective, domain: 'research'
    }, req.actor, now);
    const failed = results.some((r) => r.status === 'FAILED' || r.status === 'TIMEOUT');
    const status: ResearchStatus = contradictions.length > 0 ? 'CONFLICTED' : failed ? 'PARTIAL' : bundle.status;
    const path = decision.decision === 'REFRESH' ? 'REFRESH' : decision.decision === 'CONFLICT' ? 'CONFLICT' : 'RESEARCH';
    return { path, status, bundle: { ...bundle, status }, task_id: taskId, agentsRun: selected.map((a) => a.id), basis: decision.basis };
  }

  /** Dependency-scoped refresh targeting: only tasks whose results touch the event. */
  affectedTasks(event: MarketEvent): string[] {
    const refs = new Set([...event.entity_refs, ...event.instrument_ids.map((id) => `instrument:${id}`)]);
    const affected: string[] = [];
    for (const task of this.memory.findTasks({ status: 'COMPLETED' })) {
      if (!task.result_reference) continue;
      const node = this.knowledge.getEntity(task.result_reference.replace(/^node:/, ''));
      if (!node) continue;
      const depends = ((node.data as Record<string, unknown>)['depends_on'] ?? []) as string[];
      if (depends.some((d) => refs.has(d))) affected.push(task.task_id);
    }
    return affected;
  }

  async refreshForEvent(event: MarketEvent, actor: string, now = Date.now()): Promise<{ markers: string[]; refreshed: { task_id: string; outcome: InvestigationOutcome }[] }> {
    const markers = this.memory.applyMarketEvent(event, actor, now);
    const refreshed: { task_id: string; outcome: InvestigationOutcome }[] = [];
    for (const taskId of this.affectedTasks(event)) {
      const node = this.knowledge.getEntity(taskId);
      const data = (node?.data ?? {}) as Record<string, unknown>;
      const outcome = await this.investigate({
        subject: String(data['subject'] ?? ''),
        objective: String(data['objective'] ?? ''),
        scope: String(data['scope'] ?? 'general'),
        agent: 'event-refresh',
        actor,
        events: [event],
        now
      });
      refreshed.push({ task_id: taskId, outcome });
    }
    return { markers, refreshed };
  }

  // -- internals ---------------------------------------------------------------

  private intakeEvidence(items: EvidenceItem[]): FilteredEvidence & { rejectedSecrets: EvidenceItem[] } {
    // Secrets never enter the research pipeline: excluded items are named, not dropped silently.
    const rejectedSecrets = items.filter((e) => containsSecretPayload([e.source_identifier, e.source, e.content]));
    const rejectedIds = new Set(rejectedSecrets.map((e) => e.evidence_id));
    const filtered = filterEvidence(items.filter((e) => !rejectedIds.has(e.evidence_id)));
    return { ...filtered, rejectedSecrets };
  }

  private hasNewEvidence(req: ResearchRequest): boolean {
    return (req.evidence?.length ?? 0) > 0 || (req.bars?.length ?? 0) > 0 || (req.events?.length ?? 0) > 0;
  }

  private async runGuarded(agent: ResearchAgent, ctx: AgentContext, timeoutMs: number, now: number): Promise<AgentResult> {
    const agentCtx: AgentContext = { ...ctx, task: { ...ctx.task } };
    try {
      return await Promise.race([
        agent.run(agentCtx),
        new Promise<AgentResult>((_, reject) => setTimeout(() => reject(new Error('AGENT_TIMEOUT')), timeoutMs))
      ]);
    } catch (e) {
      const timedOut = e instanceof Error && e.message === 'AGENT_TIMEOUT';
      return failedResult(agent.id, ctx.task.task_id, ctx.task.subject, timedOut ? 'TIMEOUT' : 'FAILED', now, timedOut ? `agent exceeded ${timeoutMs}ms` : `agent error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private crossContradictions(results: AgentResult[]): string[] {
    const out: string[] = [];
    const byMetric = new Map<string, { value: unknown; agent: string }[]>();
    for (const r of results) {
      for (const o of r.observations) {
        if (!o.metric) continue;
        const key = `${o.subject}|${o.metric}|${o.period ?? ''}`;
        const list = byMetric.get(key) ?? [];
        list.push({ value: o.value, agent: r.agent });
        byMetric.set(key, list);
      }
      for (const c of r.contradictions) out.push(`${r.agent}: ${c}`);
    }
    for (const [key, list] of byMetric) {
      const values = new Set(list.map((l) => stableStringify(l.value)));
      if (values.size > 1) {
        out.push(`cross-agent conflict on ${key}: ${list.map((l) => `${l.agent}=${stableStringify(l.value)}`).join(' vs ')} (preserved, unresolved)`);
      }
    }
    return out;
  }

  private assemble(req: ResearchRequest, taskId: string, results: AgentResult[], contradictions: string[], sourcesExcluded: string[], now: number): ResearchResultBundle {
    const observations = results.flatMap((r) => r.observations);
    const evidence = results.flatMap((r) => r.evidence);
    const depends = [...new Set([
      req.subject,
      ...results.flatMap((r) => r.observations.flatMap((o) => o.inputs_ref)),
      ...evidence.map((e) => e.subject)
    ])];
    const confidences = results.filter((r) => r.status === 'COMPLETED').map((r) => r.confidence);
    const confidence = confidences.length > 0 ? confidences.reduce((s, c) => s + c, 0) / confidences.length : 0;
    const conclusions = results.flatMap((r) => r.conclusions.map((c) => `[${r.agent}] ${c}`));
    const failed = results.filter((r) => r.status === 'FAILED' || r.status === 'TIMEOUT');
    let status: ResearchStatus = 'COMPLETED';
    if (results.every((r) => r.status === 'INSUFFICIENT_DATA' || r.status === 'DATA_QUARANTINED')) {
      status = results.some((r) => r.status === 'DATA_QUARANTINED') ? 'DATA_QUARANTINED' : 'INSUFFICIENT_DATA';
    } else if (failed.length > 0 || results.some((r) => r.status === 'PARTIAL')) {
      status = 'PARTIAL';
    }
    return {
      task_id: taskId,
      subject: req.subject,
      objective: req.objective,
      scope: req.scope ?? 'general',
      status,
      agent_results: results,
      observations,
      evidence,
      contradictions,
      confidence,
      conclusion: conclusions.join(' '),
      depends_on: depends,
      knowledge_refs: [],
      sources_excluded: [...sourcesExcluded],
      created_at: now
    };
  }

  private commitBundle(req: ResearchRequest, bundle: ResearchResultBundle, now: number): string[] {
    const refs: string[] = [];
    // Evidence discipline: the bundle cites agent evidence where present, else its
    // own observations + task (never an empty evidence list — store policy rejects it).
    const bundleEvidence = bundle.evidence.length > 0
      ? bundle.evidence.map((e) => e.evidence_id)
      : [bundle.task_id, ...bundle.observations.map((o) => o.observation_id)];
    const bundleInput: KnowledgeProposalInput = {
      assertion: 'OBSERVATION',
      ops: [{ op: 'upsert-node', node: { id: `research:${bundle.task_id}`, kind: 'Observation', label: `${bundle.objective} — ${bundle.subject}`, data: { ...bundle, agent_results: bundle.agent_results.map((r) => ({ agent: r.agent, status: r.status, observations: r.observations.length })) } } }],
      provenance: {
        source: 'research-orchestrator', source_type: 'agent', source_identifier: `research:${bundle.task_id}`,
        observed_at: now, agent: req.actor, evidence_refs: bundleEvidence,
        confidence: bundle.confidence
      },
      actor: req.actor
    };
    const committed = this.knowledge.proposeValidateCommit(bundleInput);
    refs.push(committed.event.entity_ref);
    for (const r of bundle.agent_results) {
      for (const p of r.knowledge_proposals) {
        const assertion: KnowledgeLabel = p.assertion === 'FACT' ? 'INFERENCE' : p.assertion;
        const agentEvidence = r.evidence.length > 0
          ? r.evidence.map((e) => e.evidence_id)
          : [...r.observations.map((o) => o.observation_id), bundle.task_id];
        if (agentEvidence.length === 0) {
          refs.push(`skipped:${r.agent}`);
          continue;
        }
        const input: KnowledgeProposalInput = {
          assertion,
          ops: [{ op: 'upsert-node', node: { id: `research-obs:${bundle.task_id}:${r.agent}:${refs.length}`, kind: 'Observation', label: p.summary.slice(0, 120), data: { entity: req.subject, topic: req.objective, domain: 'research', summary: p.summary, coerced: p.assertion !== assertion, task_id: bundle.task_id } } }],
          provenance: {
            source: `research-agent:${r.agent}`, source_type: 'agent', source_identifier: `${r.agent}:${bundle.task_id}`,
            observed_at: now, agent: req.actor, evidence_refs: agentEvidence, confidence: r.confidence
          },
          actor: req.actor
        };
        try {
          const c = this.knowledge.proposeValidateCommit(input);
          refs.push(c.event.entity_ref);
        } catch {
          refs.push(`failed:${r.agent}`);
        }
      }
    }
    return refs;
  }

  private loadCachedBundle(subject: string, objective: string): ResearchResultBundle | null {
    const tasks = this.memory.findTasks({ subject }).filter((t) => t.objective === objective && t.status === 'COMPLETED' && t.result_reference);
    if (tasks.length === 0) return null;
    const latest = tasks[tasks.length - 1]!;
    const node = this.knowledge.getEntity(latest.result_reference!.replace(/^node:/, ''));
    if (!node) return null;
    return node.data as unknown as ResearchResultBundle;
  }
}
