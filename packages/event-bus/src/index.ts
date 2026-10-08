// @aurix/event-bus — SQLite outbox abstraction (SQLite backend only, Phase 1).
//
// Delivery semantics: AT-LEAST-ONCE. claim() re-delivers CLAIMED-but-unacked
// events on subsequent claims, and FAILED events are retried indefinitely.
// Consumers MUST be idempotent: execution deduplicates via idempotency_keys,
// publish() collapses duplicate idempotency keys to the original event.
// No event is silently dropped: fail() records last_error + attempts.
export interface BusEvent {
  id: string;
  type: string;
  payload: unknown;
  status: 'PENDING' | 'CLAIMED' | 'DONE' | 'FAILED';
  idempotencyKey: string | null;
  createdAt: number;
  claimedBy: string | null;
  attempts: number;
  lastError: string | null;
}

export interface EventStore {
  exec(sql: string): void;
  prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown };
}

type Row = {
  id: string; type: string; payload_json: string; status: string;
  idempotency_key: string | null; created_at: number; claimed_by: string | null;
  attempts: number; last_error: string | null;
};

function toEvent(r: Row): BusEvent {
  return {
    id: r.id, type: r.type, payload: JSON.parse(r.payload_json),
    status: r.status as BusEvent['status'], idempotencyKey: r.idempotency_key,
    createdAt: r.created_at, claimedBy: r.claimed_by, attempts: r.attempts, lastError: r.last_error
  };
}

let seq = 0;

export class EventBus {
  constructor(private db: EventStore) {}

  publish(type: string, payload: unknown, opts?: { idempotencyKey?: string; id?: string }): BusEvent {
    const id = opts?.id ?? `evt-${Date.now()}-${(seq += 1)}`;
    const key = opts?.idempotencyKey ?? null;
    try {
      this.db.prepare(
        `INSERT INTO events(id,type,payload_json,status,idempotency_key,created_at,attempts) VALUES(?,?,?,?,?,?,0)`
      ).run(id, type, JSON.stringify(payload), 'PENDING', key, Date.now());
    } catch (e) {
      if (key) {
        // Idempotent replay: return the original event instead of duplicating.
        const row = this.db.prepare(`SELECT * FROM events WHERE idempotency_key=?`).get(key) as Row | undefined;
        if (row) return toEvent(row);
      }
      throw e;
    }
    const row = this.db.prepare(`SELECT * FROM events WHERE id=?`).get(id) as Row;
    return toEvent(row);
  }

  claim(types: string[], worker: string, limit = 50): BusEvent[] {
    const placeholders = types.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM events WHERE status IN ('PENDING','FAILED') AND type IN (${placeholders}) ORDER BY created_at ASC LIMIT ?`
    ).all(...types, limit) as Row[];
    for (const r of rows) {
      this.db.prepare(`UPDATE events SET status='CLAIMED', claimed_by=?, attempts=attempts+1 WHERE id=?`).run(worker, r.id);
    }
    return (this.db.prepare(`SELECT * FROM events WHERE claimed_by=? AND status='CLAIMED'`).all(worker) as Row[]).map(toEvent);
  }

  ack(id: string): void {
    this.db.prepare(`UPDATE events SET status='DONE' WHERE id=?`).run(id);
  }

  fail(id: string, error: string): void {
    this.db.prepare(`UPDATE events SET status='FAILED', last_error=? WHERE id=?`).run(error, id);
  }

  get(id: string): BusEvent | undefined {
    const row = this.db.prepare(`SELECT * FROM events WHERE id=?`).get(id) as Row | undefined;
    return row ? toEvent(row) : undefined;
  }
}
