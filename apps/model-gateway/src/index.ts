// @aurix/model-gateway — stub + ollama-shaped providers, config-driven (Amendment 1).
// No auto-download, no GPU assumption. Redaction + audit enforced here.
import type { GatewayProvider } from '@aurix/config-loader';

export interface GatewayConfig {
  provider: GatewayProvider;
  model: string;
  endpoint: string;
  timeout_ms: number;
  generation: { temperature: number; max_tokens: number };
  maxInputChars?: number;
  maxRetries?: number;
}

export type GatewayErrorCode =
  | 'SECRET_REDACTED'
  | 'MODEL_INPUT_TOO_LARGE'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_TIMEOUT'
  | 'MODEL_MALFORMED'
  | 'MODEL_UPSTREAM';

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly attempts: number;
  readonly retryable: boolean;
  constructor(code: GatewayErrorCode, message: string, attempts = 1, retryable = false) {
    super(`${code}: ${message}`);
    this.name = 'GatewayError';
    this.code = code;
    this.attempts = attempts;
    this.retryable = retryable;
  }
}

export interface GatewayAudit {
  ts: number;
  provider: string;
  model: string;
  endpoint: string;
  promptName: string;
  promptVersion: string;
  caller: string;
  traceId: string;
  latencyMs: number;
  redacted: boolean;
  attempts?: number;
  errorCode?: GatewayErrorCode;
}

const SECRET_RE = /(api[_-]?key|secret|token|password|private[_-]?key|kite)/i;

export function containsSecret(text: string): boolean {
  return SECRET_RE.test(text);
}

export class ModelGateway {
  readonly audits: GatewayAudit[] = [];
  constructor(private config: GatewayConfig) {}

  get provider(): string {
    return this.config.provider;
  }
  get model(): string {
    return this.config.model;
  }

  /** Swap provider/model/endpoint without touching agents or knowledge (Amendment 1). */
  reconfigure(patch: Partial<GatewayConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  async chat(req: { promptName: string; promptVersion: string; input: string; caller: string; traceId: string }): Promise<{ text: string; provider: string; model: string }> {
    const started = Date.now();
    const audit = (patch: Partial<GatewayAudit>) => {
      this.audits.push({
        ts: Date.now(), provider: this.config.provider, model: this.config.model,
        endpoint: this.config.endpoint, promptName: req.promptName,
        promptVersion: req.promptVersion, caller: req.caller,
        traceId: req.traceId, latencyMs: Date.now() - started, redacted: false,
        ...patch
      });
    };
    if (containsSecret(req.input)) {
      audit({ redacted: true, attempts: 0, errorCode: 'SECRET_REDACTED' });
      throw new GatewayError('SECRET_REDACTED', 'input blocked by gateway redaction', 0);
    }
    const maxInput = this.config.maxInputChars ?? 8000;
    if (req.input.length > maxInput) {
      audit({ redacted: false, attempts: 0, errorCode: 'MODEL_INPUT_TOO_LARGE' });
      throw new GatewayError('MODEL_INPUT_TOO_LARGE', `input ${req.input.length} chars exceeds cap ${maxInput}`, 0);
    }
    if (this.config.provider === 'stub') {
      audit({ attempts: 1 });
      return { text: `stub[${this.config.model}]:${req.promptName}:${req.input.slice(0, 64)}`, provider: 'stub', model: this.config.model };
    }
    // ollama-shaped OpenAI-compatible call (interface only; tests stub fetch).
    const maxRetries = this.config.maxRetries ?? 2;
    const backoffMs = [100, 400, 1600];
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        const res = await this.fetchFn()(`${this.config.endpoint.replace(/\/$/, '')}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.config.model,
            messages: [{ role: 'user', content: req.input }],
            temperature: this.config.generation.temperature,
            max_tokens: this.config.generation.max_tokens
          }),
          signal: AbortSignal.timeout(Math.max(1, this.config.timeout_ms))
        });
        if (!res.ok) {
          if (res.status === 404) {
            audit({ attempts: attempt, errorCode: 'MODEL_UNAVAILABLE' });
            throw new GatewayError('MODEL_UNAVAILABLE', 'configured model absent; no auto-download', attempt);
          }
          const retryableUpstream = res.status === 429 || (res.status >= 500 && res.status < 600);
          if (!retryableUpstream) {
            audit({ attempts: attempt, errorCode: 'MODEL_UPSTREAM' });
            throw new GatewayError('MODEL_UPSTREAM', `gateway upstream ${res.status} (not retried)`, attempt);
          }
          throw new GatewayError('MODEL_UPSTREAM', `gateway upstream ${res.status}`, attempt, true);
        }
        const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.length === 0) {
          audit({ attempts: attempt, errorCode: 'MODEL_MALFORMED' });
          throw new GatewayError('MODEL_MALFORMED', 'upstream returned no usable message content', attempt);
        }
        audit({ attempts: attempt });
        return { text: content, provider: 'ollama', model: this.config.model };
      } catch (err) {
        const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        if (err instanceof GatewayError && !err.retryable) throw err;
        const retryable = timeout || (err instanceof GatewayError && err.retryable);
        if (!retryable || attempt > maxRetries) {
          if (timeout) {
            audit({ attempts: attempt, errorCode: 'MODEL_TIMEOUT' });
            throw new GatewayError('MODEL_TIMEOUT', `request exceeded ${this.config.timeout_ms}ms`, attempt);
          }
          if (err instanceof GatewayError) throw err;
          audit({ attempts: attempt, errorCode: 'MODEL_UPSTREAM' });
          throw new GatewayError('MODEL_UPSTREAM', err instanceof Error ? err.message : String(err), attempt);
        }
        await new Promise((r) => setTimeout(r, backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]));
      }
    }
  }

  private fetchFn(): typeof fetch {
    const g = globalThis as { __aurixFetch?: typeof fetch };
    return g.__aurixFetch ?? fetch;
  }
}
