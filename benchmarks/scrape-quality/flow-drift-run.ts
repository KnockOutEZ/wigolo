/**
 * Standalone G2 report: `npx tsx benchmarks/scrape-quality/flow-drift-run.ts`.
 *
 * The gate assertions live in `tests/integration/studio-flow-g2.test.ts`; this entry point exists so
 * the NUMBER can be read without reading a test runner's output, since the number is the deliverable.
 */
import { createLogger } from '../../src/logger.js';
import { runFlowDrift, renderFlowDriftReport, runWrongElementProbe, runDegradationProbe } from './flow-drift.js';

const log = createLogger('extract');
log.info(renderFlowDriftReport(runFlowDrift()));
log.info(`wrong-element probe: ${JSON.stringify(runWrongElementProbe(), null, 2)}`);
log.info(`degradation probe: ${JSON.stringify(runDegradationProbe(), null, 2)}`);
