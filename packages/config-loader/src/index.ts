// @aurix/config-loader — YAML + env overlay + strict Phase 1 validation.
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { Mode } from '@aurix/contracts';

export type GatewayProvider = 'stub' | 'ollama';

export interface AurixConfig {
  mode: Mode;
  broker: 'sim';
  exchange_scope: string[];
  model_gateway: {
    provider: GatewayProvider;
    model: string;
    endpoint: string;
    timeout_ms: number;
    generation: { temperature: number; max_tokens: number };
  };
  data: { timeframes: string[]; staleness_s: Record<string, number> };
  safety: {
    bind_localhost_only: boolean;
    require_risk_verdict: boolean;
    require_safety_gate: boolean;
    unknown_means_blocked: boolean;
    allow_live: boolean;
    decision_ttl_s: number;
    market_data_staleness_s: number;
  };
  promotion: { state: 'DRAFT' };
}

export interface RiskPolicy {
  version: string;
  max_position_notional_pct: number;
  max_portfolio_gross_pct: { paper_shadow: number; controlled_live: number };
  max_sector_pct: number;
  max_leverage: number;
  max_margin_util_pct: number;
  max_daily_loss_pct: number;
  max_drawdown_pct: number;
  liquidity_max_adv_pct: number;
  liquidity_max_spread_bps: number;
  concentration_top5_pct: number;
  abnormal_market_haircut_pct: number;
  abnormal_states: string[];
  kill_switches: string[];
}

function applyEnvOverlay(cfg: AurixConfig): AurixConfig {
  const out = { ...cfg };
  if (process.env.AURIX_MODE) out.mode = process.env.AURIX_MODE as Mode;
  if (process.env.AURIX_BROKER) out.broker = process.env.AURIX_BROKER as 'sim';
  if (process.env.AURIX_GW_PROVIDER) out.model_gateway = { ...out.model_gateway, provider: process.env.AURIX_GW_PROVIDER as GatewayProvider };
  if (process.env.AURIX_GW_MODEL) out.model_gateway = { ...out.model_gateway, model: process.env.AURIX_GW_MODEL };
  if (process.env.AURIX_GW_ENDPOINT) out.model_gateway = { ...out.model_gateway, endpoint: process.env.AURIX_GW_ENDPOINT };
  return out;
}

export function validateConfig(cfg: AurixConfig): string[] {
  const errors: string[] = [];
  if (!['RESEARCH', 'BACKTEST', 'SHADOW', 'PAPER', 'CONTROLLED_LIVE', 'AUTONOMOUS_LIVE'].includes(cfg.mode)) {
    errors.push(`invalid mode: ${cfg.mode}`);
  }
  // Phase 1 hard rule: only sim broker can execute.
  if (cfg.broker !== 'sim') errors.push(`Phase 1 only supports broker: sim (got ${cfg.broker})`);
  if (cfg.safety.allow_live !== false) errors.push('Phase 1 requires safety.allow_live=false');
  if (!['stub', 'ollama'].includes(cfg.model_gateway.provider)) {
    errors.push(`Phase 1 gateway provider must be stub|ollama (got ${cfg.model_gateway.provider})`);
  }
  if (!cfg.model_gateway.model || typeof cfg.model_gateway.model !== 'string') {
    errors.push('model_gateway.model must be a non-empty string (configurable, no arch lock-in)');
  }
  if (cfg.promotion.state !== 'DRAFT') errors.push('Phase 1 promotion.state must be DRAFT (ACTIVE impossible)');
  if (cfg.mode === 'CONTROLLED_LIVE' || cfg.mode === 'AUTONOMOUS_LIVE') {
    errors.push(`Phase 1 cannot run in ${cfg.mode}: no ACTIVE promotion can exist`);
  }
  return errors;
}

export function loadConfig(path: string): AurixConfig {
  const raw = yaml.load(readFileSync(path, 'utf8')) as AurixConfig;
  const cfg = applyEnvOverlay(raw);
  const errors = validateConfig(cfg);
  if (errors.length > 0) throw new Error(`Invalid AURIX config: ${errors.join('; ')}`);
  return cfg;
}

export function loadRiskPolicy(path: string): RiskPolicy {
  return yaml.load(readFileSync(path, 'utf8')) as RiskPolicy;
}
