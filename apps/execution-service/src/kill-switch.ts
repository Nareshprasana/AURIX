// @aurix/execution-service — kill switches (Phase 8 §35, §36).
// Deterministic, operator-controlled. The LLM can never disable them (no LLM import path).

import type { KillSwitchSnapshot } from '@aurix/execution-interface';

export interface KillSwitchCheck {
  blocked: boolean;
  reasons: string[];
}

export class KillSwitchManager {
  private globalHalt = false;
  private executionHalted = false;
  private strategies = new Set<string>();
  private instruments = new Set<string>();
  private portfolios = new Set<string>();

  activateGlobal(operator: string, reason: string): void {
    void operator;
    void reason;
    this.globalHalt = true;
  }
  deactivateGlobal(operator: string, reason: string): void {
    void operator;
    void reason;
    this.globalHalt = false;
  }
  haltExecution(operator: string, reason: string): void {
    void operator;
    void reason;
    this.executionHalted = true;
  }
  resumeExecution(operator: string, reason: string): void {
    void operator;
    void reason;
    this.executionHalted = false;
  }
  blockStrategy(id: string): void { this.strategies.add(id); }
  unblockStrategy(id: string): void { this.strategies.delete(id); }
  blockInstrument(id: string): void { this.instruments.add(id); }
  unblockInstrument(id: string): void { this.instruments.delete(id); }
  blockPortfolio(id: string): void { this.portfolios.add(id); }
  unblockPortfolio(id: string): void { this.portfolios.delete(id); }

  check(input: { strategyId?: string; instrumentId?: string; portfolioId?: string }): KillSwitchCheck {
    const reasons: string[] = [];
    if (this.globalHalt) reasons.push('global halt active');
    if (this.executionHalted) reasons.push('execution subsystem halted');
    if (input.strategyId && this.strategies.has(input.strategyId)) reasons.push(`strategy halted: ${input.strategyId}`);
    if (input.instrumentId && this.instruments.has(input.instrumentId)) reasons.push(`instrument halted: ${input.instrumentId}`);
    if (input.portfolioId && this.portfolios.has(input.portfolioId)) reasons.push(`portfolio halted: ${input.portfolioId}`);
    return { blocked: reasons.length > 0, reasons };
  }

  snapshot(): KillSwitchSnapshot {
    return {
      globalHalt: this.globalHalt,
      executionHalted: this.executionHalted,
      strategies: [...this.strategies].sort(),
      instruments: [...this.instruments].sort(),
      portfolios: [...this.portfolios].sort()
    };
  }

  restore(snap: KillSwitchSnapshot): void {
    this.globalHalt = snap.globalHalt;
    this.executionHalted = snap.executionHalted;
    this.strategies = new Set(snap.strategies);
    this.instruments = new Set(snap.instruments);
    this.portfolios = new Set(snap.portfolios);
  }
}
