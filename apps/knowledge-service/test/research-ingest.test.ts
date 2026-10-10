import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeStore, resetFixtures } from './fixtures.js';
import { buildResearchProposal, ingestResearchRecords, RESEARCH_MEMORY_CATEGORY } from '../src/research-ingest.js';

const question = {
  record: 'question', id: 'rq-abc123', question: 'Does adjusted data change the edge?',
  topic: 'adjustment', based_on: ['exp-1'], assertion: 'OBSERVATION', created_at: 1_700_000_000_100
};
const hypothesis = {
  record: 'hypothesis', id: 'hyp-def456', question_id: 'rq-abc123', question: 'q',
  hypothesis: 'adjusted data improves edge', expected_outcome: 'edge > baseline',
  falsification: 'edge <= baseline rejects', supporting_evidence: ['exp-1'],
  contradicting_evidence: [], dataset_version: 'ds-v1', feature_version: 'feat-v1',
  label_version: 'label-v1', methodology: 'm', model: 'sgd-logloss',
  hyperparameters: { alpha: 0.0001 }, baseline: null, budget: 5,
  fingerprint: 'fp-1', status: 'PROPOSED', assertion: 'OBSERVATION', created_at: 1_700_000_000_200
};
const conclusion = {
  record: 'conclusion', experiment_id: 'exp-1', outcome_class: 'GOVERNANCE_REJECTED',
  reason: 'edge -0.02 below minimum', edge: -0.02, fingerprint: 'fp-1',
  evidence: { eval: true, governance: 'REJECTED', backtest_ok: false },
  assertion: 'OBSERVATION', created_at: 1_700_000_000_300
};

describe('research ingestion (P2-1)', () => {
  beforeEach(resetFixtures);

  it('imports questions/hypotheses/conclusions with labels and provenance', () => {
    const store = makeStore();
    const summary = ingestResearchRecords(store, [question, hypothesis, conclusion]);
    expect(summary.imported).toHaveLength(3);
    expect(summary.skipped).toHaveLength(0);
    const rows = store.queryMemories(RESEARCH_MEMORY_CATEGORY);
    expect(rows).toHaveLength(3);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get('research:question:rq-abc123')?.label_class).toBe('OBSERVATION');
    expect(byKey.get('research:hypothesis:hyp-def456')?.label_class).toBe('HYPOTHESIS');
    const concl = byKey.get('research:conclusion:exp-1');
    expect(concl?.label_class).toBe('OBSERVATION');
    expect(concl?.content).toMatchObject({ outcome_class: 'GOVERNANCE_REJECTED', fingerprint: 'fp-1' });
  });

  it('is idempotent across retries and restarts (duplicates skipped, never error)', () => {
    const store = makeStore();
    const first = ingestResearchRecords(store, [question, hypothesis, conclusion]);
    expect(first.imported).toHaveLength(3);
    const second = ingestResearchRecords(store, [question, hypothesis, conclusion]);
    expect(second.imported).toHaveLength(0);
    expect(second.skipped).toHaveLength(3);
    expect(second.skipped.every((s) => /duplicate/i.test(s.reason))).toBe(true);
    expect(store.queryMemories(RESEARCH_MEMORY_CATEGORY)).toHaveLength(3);
  });

  it('rejects malformed and unsupported records without throwing', () => {
    const store = makeStore();
    const summary = ingestResearchRecords(store, [
      { record: 'question', question: 'no id', created_at: 1 },
      { record: 'telepathy', id: 'x', created_at: 1 },
      { record: 'conclusion', experiment_id: 'exp-9' },
      null,
      'just a string'
    ]);
    expect(summary.imported).toHaveLength(0);
    expect(summary.skipped).toHaveLength(5);
    expect(store.queryMemories(RESEARCH_MEMORY_CATEGORY)).toHaveLength(0);
  });

  it('never asserts FACT and never promotes (static boundary)', () => {
    const src = readFileSync('apps/knowledge-service/src/research-ingest.ts', 'utf8');
    expect(src).not.toMatch(/['"]FACT['"]/);
    expect(src).not.toMatch(/\.promote\(|['"]VALIDATED['"]|model-gateway|broker-sim|broker-kite|kiteconnect|placeOrder/i);
  });
});
