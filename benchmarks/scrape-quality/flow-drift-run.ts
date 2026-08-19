/**
 * Standalone G2 report: `npx tsx benchmarks/scrape-quality/flow-drift-run.ts`.
 *
 * The gate assertions live in `tests/integration/studio-flow-g2.test.ts`; this entry point exists so
 * the NUMBER can be read without reading a test runner's output, since the number is the deliverable.
 */
import { createLogger } from '../../src/logger.js';
import { runFlowDrift, renderFlowDriftReport } from './flow-drift.js';

const log = createLogger('extract');
log.info(renderFlowDriftReport(runFlowDrift()));
