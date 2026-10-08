// KnowledgeTables — storage abstraction. MemoryTables drives vitest;
// SqliteTables (sqlite.ts, node:sqlite) drives production wiring + the
// plain-node proof script. Store logic only depends on this interface.

export type Row = Record<string, unknown>;

export interface KnowledgeTables {
  /** Insert; throws KnowledgeConflictError on primary-key duplicate. */
  insert(table: string, row: Row): void;
  get(table: string, id: string): Row | undefined;
  query(table: string, pred?: (row: Row) => boolean): Row[];
  update(table: string, id: string, patch: Row): void;
}

export class KnowledgeConflictError extends Error {
  constructor(table: string, id: string) {
    super(`duplicate key ${id} in ${table}`);
    this.name = 'KnowledgeConflictError';
  }
}

export const TABLES = [
  'proposals',
  'nodes',
  'node_versions',
  'edges',
  'provenance',
  'knowledge_events',
  'memories',
  'embeddings',
  'versions',
  'fact_claims'
] as const;

export class MemoryTables implements KnowledgeTables {
  private data = new Map<string, Map<string, Row>>();

  private bucket(table: string): Map<string, Row> {
    let b = this.data.get(table);
    if (!b) {
      b = new Map();
      this.data.set(table, b);
    }
    return b;
  }

  insert(table: string, row: Row): void {
    const id = String(row['id'] ?? row['component'] ?? row['claim_key']);
    const b = this.bucket(table);
    if (b.has(id)) throw new KnowledgeConflictError(table, id);
    b.set(id, { ...row });
  }

  get(table: string, id: string): Row | undefined {
    const r = this.bucket(table).get(id);
    return r ? { ...r } : undefined;
  }

  query(table: string, pred?: (row: Row) => boolean): Row[] {
    const rows = [...this.bucket(table).values()].map((r) => ({ ...r }));
    return pred ? rows.filter(pred) : rows;
  }

  update(table: string, id: string, patch: Row): void {
    const b = this.bucket(table);
    const cur = b.get(id);
    if (!cur) throw new Error(`missing key ${id} in ${table}`);
    b.set(id, { ...cur, ...patch });
  }
}
