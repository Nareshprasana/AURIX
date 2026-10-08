// @aurix/execution-service — rate limiter + bounded retry (Phase 8 §28, §29, §52).
// Token bucket throttling, classified retries, no infinite loops.

import { classifyRetry, type BrokerErrorCode, type RetryClass } from '@aurix/execution-interface';

export interface RateLimiterConfig {
  maxRequestsPerSecond: number;
  burst: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  constructor(private readonly cfg: RateLimiterConfig, private readonly now: () => number = Date.now) {
    this.tokens = cfg.burst;
    this.lastRefillMs = now();
  }
  tryAcquire(count = 1): boolean {
    const t = this.now();
    const elapsedS = Math.max(0, (t - this.lastRefillMs) / 1000);
    this.tokens = Math.min(this.cfg.burst, this.tokens + elapsedS * this.cfg.maxRequestsPerSecond);
    this.lastRefillMs = t;
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }
  available(): number {
    return this.tokens;
  }
}

export interface RetryAttempt {
  attempt: number;
  code: BrokerErrorCode;
  classification: RetryClass;
  delayMs: number;
  timestamp: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 2000 };

export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export function classifyFailure(code: BrokerErrorCode): RetryClass {
  return classifyRetry(code);
}

/** Decide whether an operation may be retried. Ambiguous writes must reconcile first. */
export function shouldRetry(op: 'read' | 'placeOrder' | 'cancelOrder' | 'modifyOrder', classification: RetryClass, attempt: number, maxAttempts: number): boolean {
  if (attempt >= maxAttempts) return false;
  if (classification === 'DO_NOT_RETRY') return false;
  if (classification === 'RECONCILE_FIRST') return false; // caller must reconcile, not blind-retry
  if (op === 'read') return true; // SAFE_RETRY reads only
  return false;
}
