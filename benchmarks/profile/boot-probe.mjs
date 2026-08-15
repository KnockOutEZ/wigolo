/**
 * Cold-start attribution probe. Run as a child by boot-breakdown.ts.
 *
 * Everything is measured in ONE process, cumulatively, so each stage delta is
 * exact rather than a difference of two noisy process lifetimes. The parent
 * supplies its pre-spawn timestamp so the Node-runtime boot before this file's
 * first line is attributable too — that segment is invisible from inside.
 *
 * argv[2] = parent's pre-spawn epoch ms
 * argv[3] = dist dir
 * stdout  = one JSON line
 */
const spawnedAt = Number(process.argv[2]);
const DIST = process.argv[3];

const now = () => performance.timeOrigin + performance.now();
const marks = [];
let last = now();
function mark(name) {
  const t = now();
  marks.push({ name, ms: t - last });
  last = t;
}

const entry = now();
marks.push({ name: 'node_runtime_boot', ms: entry - spawnedAt });

// Stage 1 — config + logger only (the cheapest possible import).
await import(`${DIST}/config.js`);
mark('import_config');

// Stage 2 — the full server module graph, i.e. everything `mcp` pulls in
// before a single line of init runs.
const server = await import(`${DIST}/server.js`);
mark('import_server_graph');

// Stage 3 — individual subsystem pieces, in the order initSubsystems does them.
const { initDatabase } = await import(`${DIST}/cache/db.js`);
mark('import_db_module');

const { mkdirSync } = await import('node:fs');
const { join } = await import('node:path');
const { getConfig } = await import(`${DIST}/config.js`);
const dataDir = getConfig().dataDir;
mkdirSync(dataDir, { recursive: true });
initDatabase(join(dataDir, 'wigolo.db'));
mark('init_database');

const { getEmbeddingService } = await import(`${DIST}/embedding/embed.js`);
await getEmbeddingService().init();
mark('embedding_service_init');

const { MultiBrowserPool } = await import(`${DIST}/fetch/browser-pool.js`);
new MultiBrowserPool({ browserTypes: getConfig().browserTypes, selectionStrategy: 'round-robin' });
mark('browser_pool_ctor');

const { loadPlugins } = await import(`${DIST}/plugins/loader.js`);
await loadPlugins();
mark('load_plugins');

// Stage 4 — the real initSubsystems, on top of everything already imported and
// with the DB already open. Reported separately so the reader can see how much
// of init is NOT the pieces enumerated above.
const subs = await server.initSubsystems();
mark('initSubsystems_after_pieces');

// Stage 5 — MCP server object construction (no transport).
server.createMcpServer(subs);
mark('createMcpServer');

process.stdout.write(
  `${JSON.stringify({ total_ms: now() - spawnedAt, rss: process.memoryUsage.rss(), marks })}\n`,
);
process.exit(0);
