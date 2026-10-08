// In-memory EventStore for tests (avoids node:sqlite under Vite; real
// SQLite DDL execution is proven separately by scripts/verify-sqlite.mjs).
import type { EventStore } from '../src/index.js';

type Row = {
  id: string; type: string; payload_json: string; status: string;
  idempotency_key: string | null; created_at: number; claimed_by: string | null;
  attempts: number; last_error: string | null;
};

export class MemoryStore implements EventStore {
  rows = new Map<string, Row>();

  exec(_sql: string): void {
    // DDL is a no-op for the memory store.
  }

  prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown } {
    const norm = sql.replace(/\s+/g, ' ').trim();
    if (norm.startsWith('INSERT INTO events')) {
      return {
        get: () => undefined,
        all: () => [],
        run: (id: unknown, type: unknown, payload: unknown, status: unknown, key: unknown, created: unknown, attempts: unknown) => {
          if (key != null) {
            for (const r of this.rows.values()) {
              if (r.idempotency_key === key) throw new Error('UNIQUE constraint failed: events.idempotency_key');
            }
          }
          if (this.rows.has(id as string)) throw new Error('UNIQUE constraint failed: events.id');
          this.rows.set(id as string, {
            id: id as string, type: type as string, payload_json: payload as string,
            status: status as string, idempotency_key: (key ?? null) as string | null,
            created_at: created as number, claimed_by: null,
            attempts: (attempts as number) ?? 0, last_error: null
          });
        }
      };
    }
    if (norm === 'SELECT * FROM events WHERE idempotency_key=?') {
      return {
        get: (key: unknown) => [...this.rows.values()].find((r) => r.idempotency_key === key),
        all: (key: unknown) => [...this.rows.values()].filter((r) => r.idempotency_key === key),
        run: () => undefined
      };
    }
    if (norm === 'SELECT * FROM events WHERE id=?') {
      return {
        get: (id: unknown) => this.rows.get(id as string),
        all: (id: unknown) => { const r = this.rows.get(id as string); return r ? [r] : []; },
        run: () => undefined
      };
    }
    if (norm.startsWith('SELECT * FROM events WHERE status IN')) {
      return {
        get: () => undefined,
        all: (...args: unknown[]) => {
          const limit = args[args.length - 1] as number;
          const types = args.slice(0, -1) as string[];
          return [...this.rows.values()]
            .filter((r) => (r.status === 'PENDING' || r.status === 'FAILED') && types.includes(r.type))
            .sort((a, b) => a.created_at - b.created_at)
            .slice(0, limit);
        },
        run: () => undefined
      };
    }
    if (norm.startsWith("UPDATE events SET status='CLAIMED'")) {
      return {
        get: () => undefined,
        all: () => [],
        run: (worker: unknown, id: unknown) => {
          const r = this.rows.get(id as string);
          if (r) { r.status = 'CLAIMED'; r.claimed_by = worker as string; r.attempts += 1; }
        }
      };
    }
    if (norm === "SELECT * FROM events WHERE claimed_by=? AND status='CLAIMED'") {
      return {
        get: () => undefined,
        all: (worker: unknown) => [...this.rows.values()].filter((r) => r.claimed_by === worker && r.status === 'CLAIMED'),
        run: () => undefined
      };
    }
    if (norm === 'UPDATE events SET status=\'DONE\' WHERE id=?') {
      return {
        get: () => undefined,
        all: () => [],
        run: (id: unknown) => { const r = this.rows.get(id as string); if (r) r.status = 'DONE'; }
      };
    }
    if (norm === 'UPDATE events SET status=\'FAILED\', last_error=? WHERE id=?') {
      return {
        get: () => undefined,
        all: () => [],
        run: (error: unknown, id: unknown) => { const r = this.rows.get(id as string); if (r) { r.status = 'FAILED'; r.last_error = error as string; } }
      };
    }
    throw new Error(`MemoryStore: unsupported SQL: ${sql}`);
  }
}
