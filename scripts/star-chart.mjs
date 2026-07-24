#!/usr/bin/env node
// Generates self-hosted star-growth SVGs (light + dark) from the GitHub API,
// so the README chart always renders regardless of any third-party embed.
//
//   GITHUB_TOKEN=$(gh auth token) node scripts/star-chart.mjs
//
// Data acquisition is two-tier, because the GitHub Actions installation token
// cannot list a repo's stargazers (403), while a local PAT can:
//   - Tier A (dense): paginate /stargazers, build the full per-day history.
//     Dense wins — it overwrites any persisted series.
//   - Tier B (append): on 403/401 from the stargazer list, read the repo's
//     stargazers_count and append/replace today's point onto the persisted
//     series loaded from the published star-data.json.
//
// Env: GITHUB_TOKEN (required), GITHUB_REPOSITORY (default KnockOutEZ/wigolo),
//      OUT_DIR (default out). Writes <OUT_DIR>/{star-history.svg,
//      star-history-dark.svg, star-data.json}. One summary line to stderr.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || 'KnockOutEZ/wigolo';
const OUT_DIR = process.env.OUT_DIR || 'out';
// Test-only: force the stargazer list to behave as a 403 so Tier B (append)
// is provable locally and in CI debugging. Never set in production.
const FORCE_403 = process.env.TEST_FORCE_403 === '1';

if (!TOKEN) {
  process.stderr.write('star-chart: GITHUB_TOKEN is required\n');
  process.exit(1);
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const AUTH_HEADERS = { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'wigolo-star-chart' };

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Best-effort load of the previously published per-day series (no auth).
// Returns an array of ["YYYY-MM-DD", count] sorted ascending, or [] on miss.
async function loadPreviousSeries() {
  const url = `https://raw.githubusercontent.com/${REPO}/star-chart/star-data.json`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'wigolo-star-chart' } });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((d) => Array.isArray(d) && typeof d[0] === 'string' && Number.isFinite(d[1]))
      .sort((a, b) => a[0].localeCompare(b[0]));
  } catch {
    return [];
  }
}

// Tier A: paginate all stargazers. Returns { ok: true, times } on success, or
// { ok: false, status } when the list is forbidden (403/401) so the caller can
// fall back. Any other non-ok status is a hard failure.
async function fetchStargazers() {
  const times = [];
  for (let page = 1; ; page++) {
    let res;
    if (page === 1 && FORCE_403) {
      res = { ok: false, status: 403, statusText: 'Forbidden (TEST_FORCE_403)', text: async () => 'forced 403 for testing', headers: new Map() };
    } else {
      res = await fetch(`https://api.github.com/repos/${REPO}/stargazers?per_page=100&page=${page}`, {
        headers: { Accept: 'application/vnd.github.star+json', ...AUTH_HEADERS },
      });
    }
    if (!res.ok) {
      if (res.status === 403 || res.status === 401) return { ok: false, status: res.status };
      const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 300);
      const remaining = res.headers.get('x-ratelimit-remaining');
      const limit = res.headers.get('x-ratelimit-limit');
      process.stderr.write(
        `star-chart: GitHub API ${res.status} ${res.statusText} on page ${page} ` +
          `(ratelimit ${remaining}/${limit}): ${body}\n`,
      );
      process.exit(1);
    }
    const batch = await res.json();
    for (const entry of batch) {
      if (entry && entry.starred_at) times.push(new Date(entry.starred_at).getTime());
    }
    if (batch.length < 100) break;
  }
  return { ok: true, times: times.sort((a, b) => a - b) };
}

// Tier B: read the repo's stargazers_count (works with the Actions token).
async function fetchStarCount() {
  const res = await fetch(`https://api.github.com/repos/${REPO}`, {
    headers: { Accept: 'application/vnd.github+json', ...AUTH_HEADERS },
  });
  if (!res.ok) {
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 300);
    const remaining = res.headers.get('x-ratelimit-remaining');
    const limit = res.headers.get('x-ratelimit-limit');
    process.stderr.write(
      `star-chart: GitHub API ${res.status} ${res.statusText} on repo GET ` +
        `(ratelimit ${remaining}/${limit}): ${body}\n`,
    );
    process.exit(1);
  }
  return (await res.json()).stargazers_count;
}

// Dense timestamps -> one ["YYYY-MM-DD", cumulativeCount] point per day.
function densifyToDaily(times) {
  const byDay = new Map();
  times.forEach((t, i) => byDay.set(new Date(t).toISOString().slice(0, 10), i + 1));
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// Append/replace today's count onto the persisted per-day series.
function appendToday(previous, count) {
  const merged = previous.slice();
  const d = today();
  if (merged.length && merged[merged.length - 1][0] === d) merged[merged.length - 1] = [d, count];
  else merged.push([d, count]);
  return merged;
}

// Per-day series -> renderer input, with a final "now" point so the line
// reaches today.
function toRenderSeries(daily) {
  const now = Date.now();
  if (daily.length === 0) return { points: [[now, 0]], total: 0, now };
  const points = daily.map(([d, c]) => [Date.parse(`${d}T00:00:00Z`), c]);
  const total = daily[daily.length - 1][1];
  if (points[points.length - 1][0] < now) points.push([now, total]);
  return { points, total, now };
}

function niceCeil(n) {
  if (n <= 5) return 5;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    const step = m * pow;
    if (Math.ceil(n / step) * step >= n) return Math.ceil(n / step) * step;
  }
  return Math.ceil(n / pow) * pow;
}

function fmtDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function renderSvg({ points, total, now }, theme) {
  const W = 880;
  const H = 360;
  const padL = 64;
  const padR = 32;
  const padT = 56;
  const padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const t0 = points[0][0];
  const t1 = points[points.length - 1][0];
  const spanT = Math.max(1, t1 - t0);
  const yMax = niceCeil(Math.max(total, 1));

  const x = (t) => padL + ((t - t0) / spanT) * plotW;
  const y = (c) => padT + plotH - (c / yMax) * plotH;

  const coords = points.map(([t, c]) => [x(t), y(c)]);
  const linePath = coords.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${coords[coords.length - 1][0].toFixed(1)} ${(padT + plotH).toFixed(1)} L${coords[0][0].toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

  const bg = theme === 'dark' ? '#0d1117' : 'transparent';
  const textColor = theme === 'dark' ? '#94a3b8' : '#334155';
  const gridColor = theme === 'dark' ? '#1e293b' : '#e2e8f0';
  const line = '#7c3aed';

  // 4 horizontal gridlines (including 0 and yMax).
  const rows = [0, 1, 2, 3, 4];
  const grid = rows
    .map((r) => {
      const val = Math.round((yMax / 4) * r);
      const gy = y(val);
      return (
        `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${(padL + plotW).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${gridColor}" stroke-width="1"/>` +
        `<text x="${padL - 10}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="14" fill="${textColor}">${val}</text>`
      );
    })
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <text x="${padL}" y="32" font-size="20" font-weight="600" fill="${textColor}">wigolo — GitHub stars over time</text>
  <text x="${W - padR}" y="30" text-anchor="end" font-size="26" font-weight="700" fill="${line}">${total} ★</text>
  <text x="${W - padR}" y="48" text-anchor="end" font-size="13" fill="${textColor}" opacity="0.7">updated ${fmtDate(now)}</text>
  ${grid}
  <path d="${areaPath}" fill="${line}" fill-opacity="0.12" stroke="none"/>
  <path d="${linePath}" fill="none" stroke="${line}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <text x="${padL}" y="${H - 16}" text-anchor="start" font-size="14" fill="${textColor}">${fmtDate(t0)}</text>
  <text x="${padL + plotW}" y="${H - 16}" text-anchor="end" font-size="14" fill="${textColor}">${fmtDate(t1)}</text>
</svg>
`;
}

async function main() {
  const previous = await loadPreviousSeries();
  const stargazers = await fetchStargazers();

  let daily;
  let mode;
  if (stargazers.ok) {
    daily = densifyToDaily(stargazers.times);
    mode = 'dense';
  } else {
    process.stderr.write(
      `star-chart: stargazer list returned ${stargazers.status}; falling back to repo star count (append mode)\n`,
    );
    const count = await fetchStarCount();
    daily = appendToday(previous, count);
    mode = 'append';
  }

  const series = toRenderSeries(daily);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'star-history.svg'), renderSvg(series, 'light'), 'utf-8');
  writeFileSync(join(OUT_DIR, 'star-history-dark.svg'), renderSvg(series, 'dark'), 'utf-8');
  writeFileSync(join(OUT_DIR, 'star-data.json'), JSON.stringify(daily, null, 2) + '\n', 'utf-8');
  process.stderr.write(
    `star-chart: ${REPO} — ${series.total} stars, ${daily.length} days, wrote 2 SVGs + star-data.json to ${OUT_DIR}/ (${mode})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`star-chart: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
