// @aurix/memory-manager — deterministic memory-aware layer (Phase 4).
export { MemoryManager } from './manager.js';
export type {
  RetrievalFilter, RetrievalHit, ReuseRequest, ReuseDecision, ReuseDecisionValue,
  TopicRule, GapStatus, ResearchTaskRecord, TaskStatus, MarkerStatus
} from './manager.js';
export { MEMORY_FRESHNESS, classifyMemoryAge, normalizeText, jaccardSimilarity, normalizeTaskKey } from './freshness.js';
export type { MemoryDomain, MemoryFreshness, FreshnessPolicy } from './freshness.js';
