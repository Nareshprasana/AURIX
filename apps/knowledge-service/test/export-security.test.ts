import { describe, expect, it, beforeEach } from 'vitest';
import { buildExport, verifyExport } from '../src/index.js';
import { makeStore, nodeInput, prov, resetFixtures } from './fixtures.js';

describe('knowledge export (.akpkg foundation)', () => {
  beforeEach(resetFixtures);

  function built() {
    const store = makeStore();
    store.proposeValidateCommit(nodeInput('company:EXP1', { sector: 'Energy' }));
    store.proposeValidateCommit(nodeInput('company:EXP2', { sector: 'IT' }));
    return { store, pkg: buildExport(store, { now: 1_700_000_000_000 }) };
  }

  it('builds a deterministic package (identical checksums across builds)', () => {
    const { store } = built();
    const a = buildExport(store, { now: 1_700_000_000_000 });
    const b = buildExport(store, { now: 1_700_000_000_000 });
    expect(a.checksums).toEqual(b.checksums);
    expect(a.manifest).toMatchObject({ format: 'akpkg', knowledge_version: 2, event_count: 2, node_count: 2 });
  });

  it('verifies a valid package and detects tampering', () => {
    const { pkg } = built();
    expect(verifyExport(pkg)).toEqual([]);
    const tampered = { ...pkg, events: [...pkg.events] };
    tampered.events[0] = { ...tampered.events[0], entity_ref: 'company:EVIL' };
    expect(verifyExport(tampered).length).toBeGreaterThan(0);
  });

  it('package contains snapshot, events, provenance, versions', () => {
    const { pkg } = built();
    expect(pkg.snapshot.nodes).toHaveLength(2);
    expect(pkg.events).toHaveLength(2);
    expect(pkg.provenance.length).toBeGreaterThanOrEqual(2);
    expect(pkg.manifest.schema_version).toBe('graph-v1');
  });
});

describe('knowledge security', () => {
  beforeEach(resetFixtures);

  it('rejects proposals carrying credential-shaped material', () => {
    const store = makeStore();
    const v = store.validate(
      store.propose(nodeInput('company:SEC', { note: 'deploy key: api_key=SECRET123' })).id
    );
    expect(v.state).toBe('REJECTED');
    expect(v.reasons.join(' ')).toMatch(/SECRET_DETECTED/);
    expect(store.knowledgeVersion()).toBe(0);
  });

  it('rejects private-key blocks in evidence', () => {
    const store = makeStore();
    const v = store.validate(
      store.propose(nodeInput('company:SEC2', {}, 'OBSERVATION', prov({ evidence_refs: ['-----BEGIN PRIVATE KEY-----\nMIIB'] }))).id
    );
    expect(v.state).toBe('REJECTED');
  });

  it('committed knowledge and exports contain no secret-shaped strings', () => {
    const store = makeStore();
    store.proposeValidateCommit(nodeInput('company:CLEAN', { note: 'Kite Connect is a broker API (public prose, no credential)' }));
    const snap = store.snapshotCanonical();
    expect(snap).not.toMatch(/api_key\s*=/i);
    const pkg = buildExport(store, { now: 1_700_000_000_000 });
    expect(verifyExport(pkg)).toEqual([]);
  });
});
