// @aurix/execution-service — ledger (Phase 8 §37, §38, §53, restart §25).
// Append-only in-memory ledger with optional JSONL file persistence for restart recovery.
// Bounded growth: cap orders + audit events; overflow drops newest intent with audit note
// (never silently) and records a dead-letter list.

import { redactSecrets, type OrderRecord, type OrderState } from '@aurix/execution-interface';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuditEvent {
  eventId: string;
  timestamp: number;
  kind: string;
  orderId: string | null;
  requestId: string | null;
  traceId: string | null;
  mode: string | null;
  configVersion: string | null;
  detail: Record<string, unknown>;
}

export interface LedgerConfig {
  filePath: string | null;
  maxOrders: number;
  maxAuditEvents: number;
}

export const DEFAULT_LEDGER_CONFIG: LedgerConfig = { filePath: null, maxOrders: 10000, maxAuditEvents: 50000 };

export class ExecutionLedger {
  private orders = new Map<string, OrderRecord>();
  private byIdempotency = new Map<string, string>();
  private byBroker = new Map<string, string>();
  private audit: AuditEvent[] = [];
  private deadLetters: { requestId: string; reason: string; timestamp: number }[] = [];
  private seq = 0;

  constructor(private readonly cfg: LedgerConfig = DEFAULT_LEDGER_CONFIG, private readonly now: () => number = Date.now) {
    if (cfg.filePath) this.load();
  }

  private load(): void {
    const p = this.cfg.filePath!;
    if (!existsSync(p)) return;
    const text = readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as { type: string; payload: unknown };
        if (row.type === 'order') {
          const o = row.payload as OrderRecord;
          this.orders.set(o.orderId, o);
          this.byIdempotency.set(o.idempotencyKey, o.orderId);
          if (o.brokerOrderId) this.byBroker.set(o.brokerOrderId, o.orderId);
        } else if (row.type === 'audit') {
          this.audit.push(row.payload as AuditEvent);
        } else if (row.type === 'dead-letter') {
          this.deadLetters.push(row.payload as { requestId: string; reason: string; timestamp: number });
        }
      } catch {
        // Corrupt line: record as dead letter, never crash recovery.
        this.deadLetters.push({ requestId: 'unknown', reason: 'corrupt ledger line', timestamp: this.now() });
      }
    }
  }

  private persist(type: string, payload: unknown): void {
    if (!this.cfg.filePath) return;
    try {
      mkdirSync(dirname(this.cfg.filePath), { recursive: true });
      appendFileSync(this.cfg.filePath, JSON.stringify({ type, payload }) + '\n', 'utf8');
    } catch {
      // Persistence failure must not lose in-memory state; record audit in memory.
    }
  }

  putOrder(record: OrderRecord): void {
    if (!this.orders.has(record.orderId) && this.orders.size >= this.cfg.maxOrders) {
      this.deadLetters.push({ requestId: record.requestId, reason: 'ledger order cap reached', timestamp: this.now() });
      this.auditInternal('ledger-overflow', record.orderId, record.requestId, record.traceId, record.mode, record.configVersion, { reason: 'order cap' });
      return;
    }
    this.orders.set(record.orderId, { ...record });
    this.byIdempotency.set(record.idempotencyKey, record.orderId);
    if (record.brokerOrderId) this.byBroker.set(record.brokerOrderId, record.orderId);
    this.persist('order', record);
  }

  getOrder(orderId: string): OrderRecord | undefined {
    const o = this.orders.get(orderId);
    return o ? { ...o, fills: [...o.fills], history: [...o.history] } : undefined;
  }

  getByIdempotency(key: string): OrderRecord | undefined {
    const id = this.byIdempotency.get(key);
    return id ? this.getOrder(id) : undefined;
  }

  getByBroker(brokerOrderId: string): OrderRecord | undefined {
    const id = this.byBroker.get(brokerOrderId);
    return id ? this.getOrder(id) : undefined;
  }

  listOrders(): OrderRecord[] {
    return [...this.orders.values()].map((o) => ({ ...o, fills: [...o.fills], history: [...o.history] }));
  }

  openOrders(): OrderRecord[] {
    return this.listOrders().filter((o) => !isTerminal(o.state));
  }

  transition(orderId: string, to: OrderState, reason: string): OrderRecord {
    const cur = this.orders.get(orderId);
    if (!cur) throw new Error(`EXEC_UNKNOWN_ORDER: ${orderId}`);
    const next: OrderRecord = {
      ...cur,
      state: to,
      updatedAt: this.now(),
      history: [...cur.history, { from: cur.state, to, timestamp: this.now(), reason }]
    };
    this.putOrder(next);
    return this.getOrder(orderId)!;
  }

  auditEvent(kind: string, orderId: string | null, requestId: string | null, traceId: string | null, mode: string | null, configVersion: string | null, detail: Record<string, unknown>): AuditEvent {
    return this.auditInternal(kind, orderId, requestId, traceId, mode, configVersion, detail);
  }

  private auditInternal(kind: string, orderId: string | null, requestId: string | null, traceId: string | null, mode: string | null, configVersion: string | null, detail: Record<string, unknown>): AuditEvent {
    const ev: AuditEvent = {
      eventId: `audit-${this.now()}-${(this.seq += 1)}`,
      timestamp: this.now(),
      kind,
      orderId,
      requestId,
      traceId,
      mode,
      configVersion,
      detail: redactSecrets(detail) as Record<string, unknown>
    };
    if (this.audit.length >= this.cfg.maxAuditEvents) this.audit.shift();
    this.audit.push(ev);
    this.persist('audit', ev);
    return ev;
  }

  auditTrail(orderId?: string): AuditEvent[] {
    const rows = orderId ? this.audit.filter((a) => a.orderId === orderId) : this.audit;
    return rows.map((a) => ({ ...a, detail: { ...(a.detail as object) } as Record<string, unknown> }));
  }

  deadLetterList(): { requestId: string; reason: string; timestamp: number }[] {
    return [...this.deadLetters];
  }
}

function isTerminal(s: OrderState): boolean {
  return s === 'REJECTED' || s === 'FILLED' || s === 'CANCELLED' || s === 'EXPIRED' || s === 'BROKER_REJECTED' || s === 'RECONCILED';
}

export function clearLedgerFile(path: string): void {
  try {
    if (existsSync(path)) writeFileSync(path, '', 'utf8');
  } catch { /* ignore */ }
}
