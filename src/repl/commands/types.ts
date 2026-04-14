import type { SearchEngine } from '../../types.js';
import type { SmartRouter } from '../../fetch/router.js';
import type { BackendStatus } from '../../server/backend-status.js';

export interface ReplDeps {
  router: SmartRouter;
  engines: SearchEngine[];
  backendStatus: BackendStatus;
}
