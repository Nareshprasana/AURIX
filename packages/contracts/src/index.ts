// @aurix/contracts — generic, vendor/exchange-agnostic core model (Amendment 2).
// No venue-specific branches. NSE/BSE/MCX appear only as data values.

export type EligibilityState = 'LEGAL' | 'RESTRICTED' | 'UNAVAILABLE' | 'UNKNOWN';
export type MarketStatus = 'OPEN' | 'HALT' | 'AUCTION' | 'CLOSED' | 'UNKNOWN';
export type Mode = 'RESEARCH' | 'BACKTEST' | 'SHADOW' | 'PAPER' | 'CONTROLLED_LIVE' | 'AUTONOMOUS_LIVE';
export type DecisionAction = 'BUY' | 'SELL' | 'EXIT' | 'HOLD' | 'NO_TRADE' | 'REDUCE_POSITION';
export type KnowledgeLabel = 'FACT' | 'OBSERVATION' | 'INFERENCE' | 'HYPOTHESIS' | 'PREDICTION' | 'UNKNOWN';

export interface ContractSpec {
  kind: 'FUT' | 'CALL' | 'PUT' | 'SPOT';
  expiry?: string;
  strike?: number;
  optionType?: string;
}

export interface Instrument {
  id: string;
  exchange: string; // venue code as data value, never a code branch
  market: string; // e.g. 'equity', 'equity-derivatives'
  segment: string; // venue segment code, opaque
  symbol: string;
  isin: string | null;
  lot_size: number;
  tick_size: number;
  contract: ContractSpec | null;
  meta?: Record<string, unknown>;
}

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';
export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'PARTIAL' | 'CANCELLED' | 'REJECTED';

export interface OrderCmd {
  clientOrderId: string; // idempotency key
  decisionId: string;
  instrumentId: string;
  exchange: string;
  segment: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  limitPrice: number | null;
  strategyId: string;
}

export interface RiskVerdict {
  allow: boolean;
  cappedQty: number;
  reasons: string[];
  policyVersion: string;
}

export type SafetyVerdictValue = 'ALLOW' | 'REJECT';

export interface SafetyVerdict {
  verdict: SafetyVerdictValue;
  reasons: string[];
}

export interface SafetyContext {
  instrument: Instrument | null; // null = unknown instrument
  eligibility: EligibilityState;
  marketStatus: MarketStatus;
  riskVerdict: RiskVerdict | null; // null = missing
  mode: Mode;
  promotionActive: boolean;
  strategyAuthorized: boolean;
  riskHalted: boolean;
  nowTs: number;
  decisionTs: number;
  marketDataTs: number;
  decisionTtlS: number;
  marketDataStalenessS: number;
  seenIdempotencyKeys: Set<string> | string[];
  lastPrice: number | null;
  brokerMaxQty: number;
  brokerMinQty?: number;
}

export interface DecisionRecord {
  decision_id: string;
  ts: number;
  instrument: { exchange: string; market: string; segment: string; instrumentId: string };
  market_state: string;
  data_versions: Record<string, string>;
  evidence_refs: string[];
  knowledge_event_ids: string[];
  strategy: { id: string; version: string };
  model: { provider: string; model: string; promptVersion: string };
  risk: RiskVerdict;
  safety: SafetyVerdict;
  mode: Mode;
  promotion_id: string | null;
  execution: { routed: boolean; brokerOrderId: string | null; note: string };
  outcome: string | null;
}

export type PromotionState = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';

export interface LiveTradingPromotion {
  promotion_id: string;
  system_version: string;
  risk_policy_version: string;
  model_version: string;
  strategy_versions: string[];
  validation_results_ref: string;
  paper_trading_results_ref: string;
  approval_timestamp: string | null;
  operator_identity: string | null;
  state: PromotionState;
}

export interface KnowledgeEvent {
  id: string;
  event_type: string;
  entity_ref: string;
  payload: Record<string, unknown>;
  actor: string;
  label_class: KnowledgeLabel;
  evidence_refs: string[];
  prev_version: string;
  new_version: string;
  device_id: string;
  created_at: number;
}

export interface BrokerConstraints {
  minQty: number;
  maxQty: number;
  priceLowerBound: number | null;
  priceUpperBound: number | null;
}

// ---------------------------------------------------------------------------
// Phase 2 — Knowledge Platform domain (Master Spec §§12–14). Deterministic
// types only; the knowledge-service owns all writes. No venue branches.
// ---------------------------------------------------------------------------

export type EntityKind =
  | 'Company' | 'Security' | 'Instrument' | 'Exchange' | 'Sector' | 'Industry'
  | 'Commodity' | 'Currency' | 'EconomicIndicator' | 'MacroEvent' | 'NewsEvent'
  | 'FinancialMetric' | 'Strategy' | 'Model' | 'Prediction' | 'Trade' | 'Order'
  | 'Portfolio' | 'RiskEvent' | 'Agent' | 'Observation' | 'Experiment';

export type RelationshipType =
  | 'AFFECTS' | 'CORRELATED_WITH' | 'DEPENDS_ON' | 'COMPETES_WITH' | 'CAUSED'
  | 'PREDICTED' | 'OBSERVED' | 'TRADED' | 'GENERATED_SIGNAL' | 'SUPPORTED_BY'
  | 'CONTRADICTED_BY' | 'LEARNED_FROM' | 'DERIVED_FROM';

export type SourceType =
  | 'exchange-filing' | 'regulator' | 'audited-statement' | 'press'
  | 'market-data' | 'llm' | 'agent' | 'human' | 'other';

export type ValidationState = 'PROPOSED' | 'VALIDATING' | 'VALIDATED' | 'REJECTED';

export type EntityStatus = 'ACTIVE' | 'SUPERSEDED';
export type EdgeStatus = 'ACTIVE' | 'EXPIRED';

export interface ProvenanceInput {
  source: string;
  source_type: SourceType;
  source_identifier: string;
  observed_at: number;
  agent: string;
  model?: string;
  prompt_version?: string;
  evidence_refs: string[];
  confidence: number;
}

export interface KnowledgeNode {
  id: string;
  kind: EntityKind;
  label: string;
  data: Record<string, unknown>;
  label_class: KnowledgeLabel;
  version: number;
  status: EntityStatus;
  created_by: string;
  created_at: number;
  event_id: string;
}

export interface KnowledgeEdge {
  id: string;
  src: string;
  dst: string;
  rel: RelationshipType;
  data: Record<string, unknown>;
  label_class: KnowledgeLabel;
  confidence: number;
  provenance_ref: string;
  version: number;
  status: EdgeStatus;
  valid_from: number;
  valid_until: number | null;
  created_by: string;
  created_at: number;
  event_id: string;
}

export type ProposalOp =
  | { op: 'upsert-node'; node: { id: string; kind: EntityKind; label: string; data: Record<string, unknown> } }
  | { op: 'add-edge'; edge: { src: string; dst: string; rel: RelationshipType; data?: Record<string, unknown>; confidence?: number; valid_from?: number; valid_until?: number | null } }
  | { op: 'put-memory'; memory: { category: MemoryCategory; key: string; content: Record<string, unknown>; embedding_ref?: string; regime?: string; strategy_id?: string } }
  | { op: 'put-embedding'; embedding: { document_id: string; model: string; model_version: string; vector: number[]; metadata?: Record<string, unknown>; source?: string } };

export interface KnowledgeProposalInput {
  assertion: KnowledgeLabel;
  ops: ProposalOp[];
  provenance: ProvenanceInput;
  actor: string;
}

export type ProposalState = ValidationState | 'COMMITTED';

export interface KnowledgeProposal extends KnowledgeProposalInput {
  id: string;
  state: ProposalState;
  reasons: string[];
  committed_event_id: string | null;
  created_at: number;
}

export type MemoryCategory =
  | 'semantic' | 'episodic' | 'trading-experience' | 'strategy' | 'agent' | 'evidence';

export interface MemoryRecord {
  id: string;
  category: MemoryCategory;
  key: string;
  content: Record<string, unknown>;
  embedding_ref: string | null;
  regime: string | null;
  strategy_id: string | null;
  label_class: KnowledgeLabel;
  event_id: string;
  created_at: number;
}

export interface EmbeddingRecord {
  id: string;
  document_id: string;
  model: string;
  model_version: string;
  dim: number;
  vector: number[];
  metadata: Record<string, unknown>;
  source: string;
  knowledge_version: number;
  created_at: number;
}

export interface ExportManifest {
  format: 'akpkg';
  format_version: string;
  schema_version: string;
  knowledge_version: number;
  event_count: number;
  node_count: number;
  edge_count: number;
  created_by: string;
  created_at: number;
  min_compatible: string;
}

export interface KnowledgeExportPackage {
  manifest: ExportManifest;
  snapshot: { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] };
  events: KnowledgeEvent[];
  provenance: Record<string, unknown>[];
  memories: MemoryRecord[];
  embeddings: EmbeddingRecord[];
  checksums: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Phase 5 — Research & Event Intelligence domain. Structured outputs only:
// observations and conclusions, never executable trade decisions (no order,
// position, leverage or capital fields exist anywhere in this contract).
// ---------------------------------------------------------------------------

export type ResearchStatus =
  | 'COMPLETED' | 'PARTIAL' | 'INSUFFICIENT_DATA' | 'CONFLICTED'
  | 'SOURCE_UNAVAILABLE' | 'DATA_QUARANTINED' | 'MODEL_UNAVAILABLE'
  | 'TIMEOUT' | 'FAILED';

export interface EvidenceItem {
  evidence_id: string;
  kind: string;
  subject: string;
  content: Record<string, unknown>;
  source: string;
  source_type: SourceType;
  source_identifier: string;
  observed_at: number;
  retrieved_at: number;
  confidence: number;
}

export interface ResearchObservation {
  observation_id: string;
  subject: string;
  statement: string;
  metric?: string;
  value?: number | string;
  period?: string;
  methodology: string;
  inputs_ref: string[];
  data_quality: 'VALID' | 'SUSPECT' | 'QUARANTINED' | 'UNKNOWN';
  confidence: number;
}

export interface KnowledgeProposalRef {
  assertion: KnowledgeLabel;
  summary: string;
  entity_refs: string[];
}

export interface AgentResult {
  research_task_id: string;
  agent: string;
  subject: string;
  status: ResearchStatus;
  observations: ResearchObservation[];
  evidence: EvidenceItem[];
  sources: string[];
  methodology: string;
  assumptions: string[];
  contradictions: string[];
  conclusions: string[];
  confidence: number;
  knowledge_proposals: KnowledgeProposalRef[];
  missing: string[];
  created_at: number;
}

export interface ResearchResultBundle {
  task_id: string;
  subject: string;
  objective: string;
  scope: string;
  status: ResearchStatus;
  agent_results: AgentResult[];
  observations: ResearchObservation[];
  evidence: EvidenceItem[];
  contradictions: string[];
  confidence: number;
  conclusion: string;
  depends_on: string[];
  knowledge_refs: string[];
  sources_excluded: string[];
  created_at: number;
}

export interface SourceQualityPolicy {
  authority: Record<SourceType, number>;
  minAuthority: number;
  duplicateJaccard: number;
}

export const DEFAULT_SOURCE_QUALITY: SourceQualityPolicy = {
  authority: {
    'exchange-filing': 1.0,
    regulator: 1.0,
    'audited-statement': 0.95,
    'market-data': 0.9,
    press: 0.6,
    agent: 0.5,
    human: 0.5,
    llm: 0.3,
    other: 0.4
  },
  minAuthority: 0.3,
  duplicateJaccard: 0.8
};
