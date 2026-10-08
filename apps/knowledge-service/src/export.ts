// Deterministic `.akpkg` export foundation (Phase 2). Encryption and device
// sync arrive in Phase 11; this module proves determinism, completeness and
// secret-freedom of the package format defined in architecture §15.
import { createHash } from 'node:crypto';
import type { KnowledgeExportPackage } from '@aurix/contracts';
import { stableStringify } from './hash.js';
import { containsSecretPayload } from './secrets.js';
import type { KnowledgeStore } from './store.js';
import { SCHEMA_VERSION } from './store.js';

export function sha256Hex(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function buildExport(
  store: KnowledgeStore,
  opts: { createdBy?: string; minCompatible?: string; now?: number } = {}
): KnowledgeExportPackage {
  const now = opts.now ?? Date.now();
  const nodes = store.snapshotNodes();
  const edges = store.snapshotEdges();
  const events = store.eventsAfter(0);
  const provenance = store.snapshotProvenance();
  const memories = store.snapshotMemories();
  const embeddings = store.snapshotEmbeddings();
  const sections = {
    snapshot: stableStringify({ nodes, edges }),
    events: stableStringify(events),
    provenance: stableStringify(provenance),
    memories: stableStringify(memories),
    embeddings: stableStringify(embeddings)
  };
  const checksums: Record<string, string> = {};
  for (const [k, v] of Object.entries(sections)) checksums[k] = sha256Hex(v);
  const pkg: KnowledgeExportPackage = {
    manifest: {
      format: 'akpkg',
      format_version: '1',
      schema_version: SCHEMA_VERSION,
      knowledge_version: store.knowledgeVersion(),
      event_count: events.length,
      node_count: nodes.length,
      edge_count: edges.length,
      created_by: opts.createdBy ?? 'aurix-phase2',
      created_at: now,
      min_compatible: opts.minCompatible ?? '1'
    },
    snapshot: { nodes, edges },
    events,
    provenance: provenance as Record<string, unknown>[],
    memories,
    embeddings: embeddings as unknown as KnowledgeExportPackage['embeddings'],
    checksums
  };
  if (containsSecretPayload(pkg)) {
    throw new Error('EXPORT_BLOCKED: secret-shaped material in knowledge export');
  }
  return pkg;
}

export function verifyExport(pkg: KnowledgeExportPackage): string[] {
  const errors: string[] = [];
  if (pkg.manifest.format !== 'akpkg') errors.push('bad format');
  const recomputed: Record<string, string> = {
    snapshot: sha256Hex(stableStringify({ nodes: pkg.snapshot.nodes, edges: pkg.snapshot.edges })),
    events: sha256Hex(stableStringify(pkg.events)),
    provenance: sha256Hex(stableStringify(pkg.provenance)),
    memories: sha256Hex(stableStringify(pkg.memories)),
    embeddings: sha256Hex(stableStringify(pkg.embeddings))
  };
  for (const [k, v] of Object.entries(recomputed)) {
    if (pkg.checksums[k] !== v) errors.push(`checksum mismatch: ${k}`);
  }
  if (pkg.manifest.event_count !== pkg.events.length) errors.push('event count mismatch');
  if (containsSecretPayload(pkg)) errors.push('secret-shaped material in export');
  return errors;
}
