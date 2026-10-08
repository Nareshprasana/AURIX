// ESM resolve hook mapping @aurix/* bare imports to the tsc build output.
// Used by plain-node proof scripts (vitest uses aliases instead).
const MAP = {
  '@aurix/contracts': '../dist/packages/contracts/src/index.js',
  '@aurix/config-loader': '../dist/packages/config-loader/src/index.js',
  '@aurix/event-bus': '../dist/packages/event-bus/src/index.js',
  '@aurix/observability': '../dist/packages/observability/src/index.js',
  '@aurix/risk-engine': '../dist/packages/risk-engine/src/index.js',
  '@aurix/order-safety-gate': '../dist/packages/order-safety-gate/src/index.js',
  '@aurix/portfolio-engine': '../dist/packages/portfolio-engine/src/index.js',
  '@aurix/execution-interface': '../dist/packages/execution-interface/src/index.js',
  '@aurix/db-bootstrap': '../dist/packages/db-bootstrap/src/index.js',
  '@aurix/model-gateway': '../dist/apps/model-gateway/src/index.js',
  '@aurix/orchestrator': '../dist/apps/orchestrator/src/index.js',
  '@aurix/execution-service': '../dist/apps/execution-service/src/index.js',
  '@aurix/broker-sim': '../dist/apps/brokers/broker-sim/src/index.js',
  '@aurix/broker-kite': '../dist/apps/brokers/broker-kite/src/index.js',
  '@aurix/system-health': '../dist/apps/system-health/src/index.js',
  '@aurix/knowledge-service': '../dist/apps/knowledge-service/src/index.js',
  '@aurix/sync-protocol': '../dist/packages/sync-protocol/src/index.js',
  '@aurix/sync-manager': '../dist/apps/sync-manager/src/index.js',
  '@aurix/market-data': '../dist/packages/market-data/src/index.js',
  '@aurix/memory-manager': '../dist/apps/memory-manager/src/index.js',
  '@aurix/research-agents': '../dist/apps/research-agents/src/index.js',
  '@aurix/strategy': '../dist/packages/strategy/src/index.js',
  '@aurix/backtest': '../dist/apps/backtest/src/index.js'
};

export async function resolve(specifier, context, next) {
  if (Object.prototype.hasOwnProperty.call(MAP, specifier)) {
    return { url: new URL(MAP[specifier], import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
