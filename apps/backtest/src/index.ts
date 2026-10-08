// @aurix/backtest — deterministic historical simulation (Phase 6).
// Hypothetical orders only. No broker, no execution, no live orders.
export { buildDataset, hashBars, adjustSeries, barsAsOf, universeAsOf, fundamentalsAsOf, eventsAsOf } from './datasets.js';
export type { DatasetBar, PriceAdjustment, DividendAction, DatasetFundamental, DatasetEvent, UniverseEntry, BacktestDataset, AdjustedSeries } from './datasets.js';
export { runBacktest, specHashFor } from './engine.js';
export type { BacktestRequest, BacktestRun, EventWindow } from './engine.js';
export { BACKTEST_CODE_VERSION } from './engine.js';
export { splitDataset, runOos, makeWindows, runWalkForward, applyStress, runStress, parameterSweep, MAX_SWEEP_RUNS } from './methods.js';
export type { DateSplit, OosResult, WalkWindow, WalkForwardResult, StressScenario, StressResult, SweepRun } from './methods.js';
export { ExperimentRegistry, StrategyRegistry } from './registry.js';
export type { StoredExperiment, DegradationEntry } from './registry.js';
export { buildHypothesis, buildStrategyFromHypothesis, describeWithInterpreter } from './hypothesis.js';
export type { HypothesisInput, StrategyBuildInput, InterpreterLike } from './hypothesis.js';
export { experimentSpecHash, decideExperiment, recordStrategyMemory, commitExperimentResult, commitHypothesis } from './integration.js';
export type { ExperimentReuse } from './integration.js';
