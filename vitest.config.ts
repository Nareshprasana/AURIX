import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));
const alias = {
  '@aurix/contracts': `${root}packages/contracts/src/index.ts`,
  '@aurix/config-loader': `${root}packages/config-loader/src/index.ts`,
  '@aurix/event-bus': `${root}packages/event-bus/src/index.ts`,
  '@aurix/observability': `${root}packages/observability/src/index.ts`,
  '@aurix/risk-engine': `${root}packages/risk-engine/src/index.ts`,
  '@aurix/order-safety-gate': `${root}packages/order-safety-gate/src/index.ts`,
  '@aurix/portfolio-engine': `${root}packages/portfolio-engine/src/index.ts`,
  '@aurix/execution-interface': `${root}packages/execution-interface/src/index.ts`,
  '@aurix/db-bootstrap': `${root}packages/db-bootstrap/src/index.ts`,
  '@aurix/model-gateway': `${root}apps/model-gateway/src/index.ts`,
  '@aurix/orchestrator': `${root}apps/orchestrator/src/index.ts`,
  '@aurix/execution-service': `${root}apps/execution-service/src/index.ts`,
  '@aurix/broker-sim': `${root}apps/brokers/broker-sim/src/index.ts`,
  '@aurix/broker-kite': `${root}apps/brokers/broker-kite/src/index.ts`,
  '@aurix/system-health': `${root}apps/system-health/src/index.ts`,
  '@aurix/knowledge-service': `${root}apps/knowledge-service/src/index.ts`,
  '@aurix/sync-protocol': `${root}packages/sync-protocol/src/index.ts`,
  '@aurix/sync-manager': `${root}apps/sync-manager/src/index.ts`,
  '@aurix/market-data': `${root}packages/market-data/src/index.ts`,
  '@aurix/memory-manager': `${root}apps/memory-manager/src/index.ts`
};

export default defineConfig({
  resolve: { alias },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'apps/brokers/*/test/**/*.test.ts'
    ],
    testTimeout: 15000
  }
});
