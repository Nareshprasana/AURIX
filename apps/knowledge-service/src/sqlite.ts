// SqliteTables — KnowledgeTables over real SQLite (node:sqlite).
// NOT imported by index.ts or any test (vitest cannot load node:sqlite).
// Exercised by scripts/verify-knowledge-sqlite.mjs via the tsc build.
// Row codecs match packages/db-bootstrap KNOWLEDGE_DDL columns.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { KnowledgeConflictError, type KnowledgeTables, type Row } from './tables.js';

function codec(table: string, r: Row): { columns: string[]; values: unknown[] } {
  switch (table) {
    case 'proposals':
      return { columns: ['id', 'assertion', 'ops_json', 'provenance_json', 'actor', 'state', 'reasons_json', 'committed_event_id', 'created_at'],
        values: [r['id'], r['assertion'], r['ops_json'], r['provenance_json'], r['actor'], r['state'], r['reasons_json'], r['committed_event_id'] ?? null, r['created_at']] };
    case 'nodes':
      return { columns: ['id', 'kind', 'label', 'data_json', 'label_class', 'version', 'status', 'created_by', 'created_at', 'event_id'],
        values: [r['id'], r['kind'], r['label'], r['data_json'], r['label_class'], r['version'], r['status'], r['created_by'], r['created_at'], r['event_id']] };
    case 'node_versions':
      return { columns: ['id', 'node_id', 'version', 'data_json', 'label', 'label_class', 'event_id', 'created_at'],
        values: [r['id'], r['node_id'], r['version'], r['data_json'], r['label'], r['label_class'], r['event_id'], r['created_at']] };
    case 'edges':
      return { columns: ['id', 'src', 'dst', 'rel', 'data_json', 'label_class', 'confidence', 'provenance_ref', 'version', 'status', 'valid_from', 'valid_until', 'created_by', 'created_at', 'event_id'],
        values: [r['id'], r['src'], r['dst'], r['rel'], r['data_json'], r['label_class'], r['confidence'], r['provenance_ref'], r['version'], r['status'], r['valid_from'], r['valid_until'] ?? null, r['created_by'], r['created_at'], r['event_id']] };
    case 'provenance':
      return { columns: ['id', 'entity_ref', 'what', 'source', 'source_type', 'source_identifier', 'observed_at', 'ingested_at', 'agent', 'model', 'prompt_version', 'evidence_refs_json', 'confidence', 'validation_state'],
        values: [r['id'], r['entity_ref'], r['what'], r['source'], r['source_type'], r['source_identifier'], r['observed_at'], r['ingested_at'], r['agent'], r['model'] ?? null, r['prompt_version'] ?? null, r['evidence_refs_json'], r['confidence'], r['validation_state']] };
    case 'knowledge_events':
      return { columns: ['id', 'event_type', 'entity_ref', 'payload_json', 'actor', 'label_class', 'evidence_refs_json', 'prev_version', 'new_version', 'device_id', 'created_at'],
        values: [r['id'], r['event_type'], r['entity_ref'], r['payload_json'], r['actor'], r['label_class'], r['evidence_refs_json'], r['prev_version'], r['new_version'], r['device_id'], r['created_at']] };
    case 'memories':
      return { columns: ['id', 'category', 'key', 'content_json', 'embedding_ref', 'regime', 'strategy_id', 'label_class', 'event_id', 'created_at'],
        values: [r['id'], r['category'], r['key'], r['content_json'], r['embedding_ref'] ?? null, r['regime'] ?? null, r['strategy_id'] ?? null, r['label_class'], r['event_id'], r['created_at']] };
    case 'embeddings':
      return { columns: ['id', 'document_id', 'model', 'model_version', 'dim', 'vector_json', 'metadata_json', 'source', 'knowledge_version', 'created_at'],
        values: [r['id'], r['document_id'], r['model'], r['model_version'], r['dim'], r['vector_json'], r['metadata_json'], r['source'], r['knowledge_version'], r['created_at']] };
    case 'versions':
      return { columns: ['component', 'version', 'checksum', 'created_at'],
        values: [r['component'] ?? r['id'], r['version'], r['checksum'] ?? '', r['created_at']] };
    case 'fact_claims':
      return { columns: ['claim_key', 'entity_ref', 'content_hash', 'sources_json', 'created_at'],
        values: [r['claim_key'] ?? r['id'], r['entity_ref'], r['content_hash'], r['sources_json'], r['created_at']] };
    default:
      throw new Error(`sqlite: unknown table ${table}`);
  }
}

function keyOf(table: string): string {
  if (table === 'versions') return 'component';
  if (table === 'fact_claims') return 'claim_key';
  return 'id';
}

const SYNC_SNAPSHOT_TABLES = [
  'proposals', 'nodes', 'node_versions', 'edges', 'provenance',
  'knowledge_events', 'memories', 'embeddings', 'versions', 'fact_claims'
];

export interface TableSnapshot {
  table: string;
  rows: Row[];
}

export class SqliteTables implements KnowledgeTables {
  constructor(private db: DatabaseSync) {}

  insert(table: string, row: Row): void {
    const { columns, values } = codec(table, row);
    try {
      this.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...(values as SQLInputValue[]));
    } catch (e) {
      if (e instanceof Error && /UNIQUE|PRIMARY/i.test(e.message)) {
        throw new KnowledgeConflictError(table, String(values[0]));
      }
      throw e;
    }
  }

  get(table: string, id: string): Row | undefined {
    const r = this.db.prepare(`SELECT * FROM ${table} WHERE ${keyOf(table)}=?`).get(id) as Row | undefined;
    return r ? { ...r } : undefined;
  }

  query(table: string, pred?: (row: Row) => boolean): Row[] {
    const rows = this.db.prepare(`SELECT * FROM ${table}`).all() as Row[];
    const copies = rows.map((r) => ({ ...r }));
    return pred ? copies.filter(pred) : copies;
  }

  update(table: string, id: string, patch: Row): void {
    const cols = Object.keys(patch).filter((c) => c !== keyOf(table));
    if (cols.length === 0) return;
    const info = this.db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE ${keyOf(table)}=?`).run(...([...cols.map((c) => patch[c]), id] as SQLInputValue[])) as { changes: number | bigint };
    if (Number(info.changes) === 0) throw new Error(`missing key ${id} in ${table}`);
  }

  /** Full-table snapshot for merge checkpoints; restore() replays it back verbatim. */
  snapshot(): TableSnapshot[] {
    return SYNC_SNAPSHOT_TABLES.map((table) => ({ table, rows: this.query(table) }));
  }

  restore(snap: TableSnapshot[]): void {
    for (const { table, rows } of snap) {
      if (!SYNC_SNAPSHOT_TABLES.includes(table)) throw new Error(`sqlite: refuse to restore unknown table ${table}`);
      this.db.prepare(`DELETE FROM ${table}`).run();
      for (const r of rows) this.insert(table, { ...r });
    }
  }
}

export type { DatabaseSync };
