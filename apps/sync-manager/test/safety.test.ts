import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edSign, sealToRecipient, sha256hexText, SyncthingTransport } from '../src/index.js';
import { stableStringify } from '@aurix/knowledge-service';
import { commitCompany, makeDevice, sendTo, trustEachOther, type TestDevice } from './helpers.js';

function senderPrivateKey(a: TestDevice): string {
  const sign = JSON.parse(readFileSync(join(a.dir, 'sync', 'keys', 'sign.json'), 'utf8')) as { privateKey: string };
  return sign.privateKey;
}

/** Honestly-signed package carrying attacker-chosen inner content (tests importer gates). */
function writeSignedInner(b: TestDevice, a: TestDevice, inner: Record<string, unknown>, packageId: string): string {
  const sealed = sealToRecipient(b.manager.exportPublicTrust().x25519_public, Buffer.from(stableStringify(inner), 'utf8'));
  const encrypted = Buffer.from(stableStringify({ iv: sealed.iv, ciphertext: sealed.ciphertext, tag: sealed.tag }), 'utf8').toString('base64');
  const manifest: Record<string, unknown> = {
    package_id: packageId, sender_device_id: a.manager.deviceId, sender_installation_id: a.manager.installationId,
    knowledge_store_id: a.manager.knowledgeStoreId, schema_version: 'graph-v1', event_schema_version: 'kev-1',
    package_version: 'sync-pkg-1', created_at: 1, knowledge_state_version: 1, version_vector: {},
    ranges: [], event_count: 0, content_hash: sha256hexText(stableStringify(inner)), package_hash: '',
    crypto: { version: 'gcm-ed25519-v1', iv: sealed.iv, ephemeral_pub: sealed.ephemeral_pub, tag: sealed.tag }, signature: ''
  };
  const signable = stableStringify({ ...manifest, signature: null, package_hash: null });
  manifest['package_hash'] = sha256hexText(stableStringify({ manifest: signable, encrypted, ephemeral_pub: sealed.ephemeral_pub }));
  manifest['signature'] = edSign(senderPrivateKey(a), Buffer.from(signable, 'utf8'));
  const name = `${packageId}.akpkg.json`;
  writeFileSync(join(b.transport.incomingDir(), name), stableStringify({ manifest, encrypted, ephemeral_pub: sealed.ephemeral_pub }));
  return name;
}

describe('tamper matrix', () => {
  it('rejects invalid signature', () => {
    const a = makeDevice('t1a');
    const b = makeDevice('t1b');
    trustEachOther(a, b);
    commitCompany(a, 'company:T', { v: 1 });
    const file = sendTo(a, b);
    const path = join(b.transport.incomingDir(), file);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { manifest: { signature: string } };
    parsed.manifest.signature = Buffer.from('forged').toString('base64');
    writeFileSync(path, JSON.stringify(parsed));
    const r = b.manager.importPackage(b.transport, file);
    expect(r.outcome).toBe('REJECT');
    expect(r.reason).toMatch(/BAD_SIGNATURE/);
    expect(b.knowledge.knowledgeVersion()).toBe(0);
  });

  it('rejects checksum mismatch (valid signature, lying content hash)', () => {
    const a = makeDevice('t2a');
    const b = makeDevice('t2b');
    trustEachOther(a, b);
    commitCompany(a, 'company:T', { v: 1 });
    const pkg = a.manager.createPackage(b.manager.deviceId, null);
    const parsed = JSON.parse(pkg.content) as { manifest: Record<string, unknown>; encrypted: string; ephemeral_pub: string };
    parsed.manifest['content_hash'] = '0'.repeat(64);
    const signable = stableStringify({ ...parsed.manifest, signature: null, package_hash: null });
    parsed.manifest['package_hash'] = sha256hexText(stableStringify({ manifest: signable, encrypted: parsed.encrypted, ephemeral_pub: parsed.ephemeral_pub }));
    parsed.manifest['signature'] = edSign(senderPrivateKey(a), Buffer.from(signable, 'utf8'));
    const name = `${pkg.packageId}.akpkg.json`;
    writeFileSync(join(b.transport.incomingDir(), name), JSON.stringify(parsed));
    const r = b.manager.importPackage(b.transport, name);
    expect(r.outcome).toBe('REJECT');
    expect(r.reason).toMatch(/CHECKSUM_MISMATCH/);
  });

  it('rejects tampered ciphertext (GCM auth failure)', () => {
    const a = makeDevice('t3a');
    const b = makeDevice('t3b');
    trustEachOther(a, b);
    commitCompany(a, 'company:T', { v: 1 });
    const file = sendTo(a, b);
    const path = join(b.transport.incomingDir(), file);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { encrypted: string };
    parsed.encrypted = Buffer.from('tampered-bytes').toString('base64');
    writeFileSync(path, JSON.stringify(parsed));
    const r = b.manager.importPackage(b.transport, file);
    expect(r.outcome).toBe('REJECT');
    expect(r.reason).toMatch(/DECRYPT_FAILED|BAD_SIGNATURE/);
  });

  it('rejects malformed packages and moves them to rejected/', () => {
    const b = makeDevice('t4b');
    writeFileSync(join(b.transport.incomingDir(), 'pkg-bad.akpkg.json'), 'not json{{{');
    const found = b.manager.discover(b.transport);
    expect(found).toHaveLength(1);
    expect(found[0]?.status).toBe('REJECTED');
    expect(existsSync(join(b.transport.rejectedDir(), 'pkg-bad.akpkg.json'))).toBe(true);
  });

  it('wrong encryption key fails closed', () => {
    const a = makeDevice('t5a');
    const b = makeDevice('t5b');
    const c = makeDevice('t5c');
    a.manager.addTrust(c.manager.exportPublicTrust());
    b.manager.addTrust(a.manager.exportPublicTrust());
    commitCompany(a, 'company:T', { v: 1 });
    // Encrypted to C, delivered to B: B cannot decrypt.
    const pkg = a.manager.createPackage(c.manager.deviceId, null);
    a.transport.stageOutgoing(pkg.packageId, pkg.content);
    a.transport.deliver(pkg.fileName, b.transport);
    const r = b.manager.importPackage(b.transport, pkg.fileName);
    expect(r.outcome).toBe('REJECT');
    expect(r.reason).toMatch(/TRUST_CONFLICT|DECRYPT_FAILED/);
  });
});

describe('trust matrix', () => {
  it('unknown device is rejected by default; sender cannot target untrusted recipients', () => {
    const a = makeDevice('u1a');
    const b = makeDevice('u1b');
    expect(() => b.manager.createPackage(a.manager.deviceId, null)).toThrow(/NO_TRUST/);
  });

  it('quarantine mode holds unknown-device packages without applying', () => {
    const c = makeDevice('u2c');
    const b = makeDevice('u2b', { quarantineUnknown: true });
    c.manager.addTrust(b.manager.exportPublicTrust()); // C can encrypt to B; B never trusted C
    commitCompany(c, 'company:T', { v: 1 });
    const pkg = c.manager.createPackage(b.manager.deviceId, null);
    c.transport.stageOutgoing(pkg.packageId, pkg.content);
    c.transport.deliver(pkg.fileName, b.transport);
    const r = b.manager.importPackage(b.transport, pkg.fileName);
    expect(r.outcome).toBe('REJECT');
    expect(r.reason).toMatch(/PENDING_TRUST/);
    expect(b.knowledge.knowledgeVersion()).toBe(0);
  });
});

describe('schema matrix', () => {
  it('rejects future schema versions', () => {
    const a = makeDevice('s1a');
    const b = makeDevice('s1b');
    trustEachOther(a, b);
    commitCompany(a, 'company:T', { v: 1 });
    const pkg = a.manager.createPackage(b.manager.deviceId, null);
    const parsed = JSON.parse(pkg.content) as { manifest: Record<string, unknown>; encrypted: string; ephemeral_pub: string };
    parsed.manifest['schema_version'] = 'graph-v9';
    const signable = stableStringify({ ...parsed.manifest, signature: null, package_hash: null });
    parsed.manifest['package_hash'] = sha256hexText(stableStringify({ manifest: signable, encrypted: parsed.encrypted, ephemeral_pub: parsed.ephemeral_pub }));
    parsed.manifest['signature'] = edSign(senderPrivateKey(a), Buffer.from(signable, 'utf8'));
    const name = `${pkg.packageId}.akpkg.json`;
    writeFileSync(join(b.transport.incomingDir(), name), JSON.stringify(parsed));
    const r = b.manager.importPackage(b.transport, name);
    expect(r.outcome).toBe('REJECT');
    expect(r.reason).toMatch(/SCHEMA_CONFLICT/);
  });

  it('accepts older schema as UPGRADE_REQUIRED (flagged, importable)', () => {
    const a = makeDevice('s2a');
    const b = makeDevice('s2b', { schemaVersion: 'graph-v2' });
    trustEachOther(a, b);
    commitCompany(a, 'company:T', { v: 1 });
    const file = sendTo(a, b);
    const inspected = b.manager.inspectFileContent(file, b.transport.readIncoming(file));
    const report = b.manager.dryRun(inspected);
    expect(report.schemaDiff.verdict).toBe('UPGRADE_REQUIRED');
    const r = b.manager.importPackage(b.transport, file);
    expect(r.outcome).toBe('AUTO_MERGE');
  });
});

describe('security boundaries', () => {
  it('rejects secret-bearing packages', () => {
    const a = makeDevice('sec1a');
    const b = makeDevice('sec1b');
    trustEachOther(a, b);
    commitCompany(a, 'company:T', { v: 1 });
    const inner = { events: [], envelopes: [], nodes: [], edges: [], provenance: [], memories: [], embeddings: [], note: 'backup api_key=SUPERSECRET123' };
    const name = writeSignedInner(b, a, inner, 'pkg-evilsec001');
    const r = b.manager.importPackage(b.transport, name);
    expect(r.outcome).toBe('REJECT');
    expect(r.reason).toMatch(/SECRET_DETECTED/);
    expect(b.knowledge.knowledgeVersion()).toBe(0);
  });

  it('ignores unexpected files and never executes package content', () => {
    const b = makeDevice('sec2b');
    writeFileSync(join(b.transport.incomingDir(), 'notes.txt'), 'hello');
    writeFileSync(join(b.transport.incomingDir(), 'run.sh'), '#!/bin/sh\nevil');
    const found = b.manager.discover(b.transport);
    expect(found).toHaveLength(0);
    expect(existsSync(join(b.transport.incomingDir(), 'notes.txt'))).toBe(true);
    // Inert data: JS-looking strings in memory content are stored as data, never run.
    const a = makeDevice('sec2a');
    trustEachOther(a, b);
    a.knowledge.proposeValidateCommit({
      assertion: 'OBSERVATION',
      ops: [{ op: 'put-memory', memory: { category: 'evidence', key: 'k', content: { text: 'require("evil"); process.exit(1)' } } }],
      provenance: { source: 't', source_type: 'press', source_identifier: 't-1', observed_at: 1, agent: 't', evidence_refs: ['e'], confidence: 0.5 },
      actor: 't'
    });
    const file = sendTo(a, b);
    const r = b.manager.importPackage(b.transport, file);
    expect(r.outcome).toBe('AUTO_MERGE');
    expect(b.knowledge.queryMemories('evidence', 'k')[0]?.content).toEqual({ text: 'require("evil"); process.exit(1)' });
  });

  it('rejects path-traversal filenames without touching the filesystem', () => {
    const b = makeDevice('sec3b');
    expect(() => b.manager.inspectFileContent('../../evil.akpkg.json', '{}')).toThrow(/BAD_FILE/);
    expect(() => b.transport.readIncoming('../../evil.akpkg.json')).toThrow(/INVALID_PACKAGE_NAME/);
  });

  it('Syncthing layout blocks live databases and documents ignore rules', () => {
    const root = mkdtempSync(join(tmpdir(), 'aurix-st-'));
    const t = new SyncthingTransport(root);
    expect(t.stignore()).toMatch(/\.db/);
    expect(t.stignore()).toMatch(/akpkg\.json/);
    expect(t.assertNoLiveDb()).toEqual([]);
    writeFileSync(join(t.incomingDir(), 'knowledge.db'), 'fake');
    expect(() => t.assertNoLiveDb()).toThrow(/LIVE_DB_IN_SYNC_ROOT/);
  });
});
