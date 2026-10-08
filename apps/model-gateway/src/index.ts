// @aurix/model-gateway — stub + ollama-shaped providers, config-driven (Amendment 1).
// No auto-download, no GPU assumption. Redaction + audit enforced here.
import type { GatewayProvider } from '@aurix/config-loader';

export interface GatewayConfig {
  provider: GatewayProvider;
  model: string;
  endpoint: string;
  timeout_ms: number;
  generation: { temperature: number; max_tokens: number };
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
    if (containsSecret(req.input)) {
      this.audits.push({
        ts: Date.now(), provider: this.config.provider, model: this.config.model,
        endpoint: this.config.endpoint, promptName: req.promptName,
        promptVersion: req.promptVersion, caller: req.caller,
        traceId: req.traceId, latencyMs: Date.now() - started, redacted: true
      });
      throw new Error('SECRET_REDACTED: input blocked by gateway redaction');
    }
    if (this.config.provider === 'stub') {
      this.audits.push({
        ts: Date.now(), provider: 'stub', model: this.config.model,
        endpoint: this.config.endpoint, promptName: req.promptName,
        promptVersion: req.promptVersion, caller: req.caller,
        traceId: req.traceId, latencyMs: Date.now() - started, redacted: false
      });
      return { text: `stub[${this.config.model}]:${req.promptName}:${req.input.slice(0, 64)}`, provider: 'stub', model: this.config.model };
    }
    // ollama-shaped OpenAI-compatible call (interface only; tests stub fetch).
    const res = await this.fetchFn()(`${this.config.endpoint.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.config.model,
        messages: [{ role: 'user', content: req.input }],
        temperature: this.config.generation.temperature,
        max_tokens: this.config.generation.max_tokens
      })
    });
    if (!res.ok) {
      if (res.status === 404) throw new Error('MODEL_UNAVAILABLE: configured model absent; no auto-download');
      throw new Error(`gateway upstream ${res.status}`);
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? '';
    this.audits.push({
      ts: Date.now(), provider: 'ollama', model: this.config.model,
      endpoint: this.config.endpoint, promptName: req.promptName,
      promptVersion: req.promptVersion, caller: req.caller,
      traceId: req.traceId, latencyMs: Date.now() - started, redacted: false
    });
    return { text, provider: 'ollama', model: this.config.model };
  }

  private fetchFn(): typeof fetch {
    const g = globalThis as { __aurixFetch?: typeof fetch };
    return g.__aurixFetch ?? fetch;
  }
}
