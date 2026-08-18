import type { SearchEngine } from '../types.js';
import { BingEngine } from './engines/bing.js';
import { DuckDuckGoEngine } from './engines/duckduckgo.js';

/**
 * Keyless direct engines shared by the MCP server, interactive shell, and
 * headless `wigolo <tool>` runner.
 *
 * Research / agent / find_similar search this list directly. `search` on the
 * core backend builds its own orchestrator catalog and honours
 * `search_engines` there — this seed does not cap that allowlist.
 */
export function createKeylessDirectEngines(): SearchEngine[] {
  return [new BingEngine(), new DuckDuckGoEngine()];
}
