// Two-device fixtures: isolated tmp dirs, independent clocks, trust helpers.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore, MemoryTables } from '@aurix/knowledge-service';
import type { KnowledgeTables } from '@aurix/knowledge-service';
import type { KnowledgeProposalInput } from '@aurix/contracts';
import { LocalFilesystemTransport, SyncManager } from '../src/index.js';

export interface TestDevice {
  name: string;
  dir: string;
  tables: MemoryTables;
  knowledge: KnowledgeStore;
  manager: SyncManager;
  transport: LocalFilesystemTransport;
}

export function makeDevice(name: string, opts: { quarantineUnknown?: boolean; schemaVersion?: string } = {}): TestDevice {
  const dir = mkdtempSync(join(tmpdir(), `aurix-${name}-`));
  let tick = 1_700_000_000_000;
  const tables = new MemoryTables();
  const knowledge = new KnowledgeStore(tables, { deviceId: `dev-${name}`, now: () => (tick += 1000) });
  const manager = new SyncManager({ knowledge, tables, syncDir: join(dir, 'sync'), quarantineUnknown: opts.quarantineUnknown, schemaVersion: opts.schemaVersion });
  const transport = new LocalFilesystemTransport(join(dir, 'transfer'));
  return { name, dir, tables, knowledge, manager, transport };
}

export function trustEachOther(a: TestDevice, b: TestDevice): void {
  a.manager.addTrust(b.manager.exportPublicTrust());
  b.manager.addTrust(a.manager.exportPublicTrust());
}

let provSeq = 0;

export function prov(device: TestDevice, over: Record<string, unknown> = {}): KnowledgeProposalInput['provenance'] {
  provSeq += 1;
  return {
    source: `${device.name} press`,
    source_type: 'press',
    source_identifier: `${device.name}-src-${provSeq}`,
    observed_at: 1_700_000_000_000,
    agent: `${device.name}-agent`,
    evidence_refs: [`${device.name}-ev-${provSeq}`],
    confidence: 0.8,
    ...over
  } as KnowledgeProposalInput['provenance'];
}

export function commitCompany(device: TestDevice, id: string, data: Record<string, unknown>, assertion: KnowledgeProposalInput['assertion'] = 'OBSERVATION', provenance?: KnowledgeProposalInput['provenance']) {
  return device.knowledge.proposeValidateCommit({
    assertion,
    ops: [{ op: 'upsert-node', node: { id, kind: 'Company', label: id, data } }],
    provenance: provenance ?? prov(device),
    actor: `${device.name}-actor`
  });
}

/** Full send path: create package on A, stage, deliver to B, return B-side filename. */
export function sendTo(a: TestDevice, b: TestDevice, peerVV: Record<string, number> | null = null): string {
  const pkg = a.manager.createPackage(b.manager.deviceId, peerVV);
  a.transport.stageOutgoing(pkg.packageId, pkg.content);
  a.transport.deliver(pkg.fileName, b.transport);
  return pkg.fileName;
}
