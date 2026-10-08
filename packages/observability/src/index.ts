// @aurix/observability — JSONL logger with secret redaction + decision writer.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DecisionRecord } from '@aurix/contracts';

const SECRET_PATTERNS = [/api[_-]?key/i, /secret/i, /token/i, /password/i, /private[_-]?key/i, /kite/i];

export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const re of SECRET_PATTERNS) {
      if (re.test(out)) return '[REDACTED]';
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      o[k] = SECRET_PATTERNS.some((re) => re.test(k)) ? '[REDACTED]' : redact(v);
    }
    return o;
  }
  return value;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(file: string, component: string): Logger {
  mkdirSync(dirname(file), { recursive: true });
  const write = (level: string, event: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ ts: Date.now(), level, component, event, ...(redact(fields) as Record<string, unknown>) });
    appendFileSync(file, line + '\n');
  };
  return {
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f)
  };
}

export function writeDecisionRecord(file: string, record: DecisionRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(redact(record)) + '\n');
}
