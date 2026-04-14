import chalk from 'chalk';
import type {
  SearchOutput,
  FetchOutput,
  CrawlOutput,
  MapOutput,
  ExtractOutput,
  CacheOutput,
  TableData,
  MetadataData,
} from '../types.js';


const SNIPPET_MAX_LENGTH = 200;

export function stripAnsi(str: string): string {
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function pathFromUrl(url: string, baseUrl?: string): string {
  try {
    const u = new URL(url);
    if (baseUrl) {
      const base = new URL(baseUrl);
      if (u.hostname === base.hostname) {
        return u.pathname;
      }
    }
    return u.pathname;
  } catch {
    return url;
  }
}

export function formatSearchResults(output: SearchOutput): string {
  const lines: string[] = [];

  const header = `Search: ${chalk.cyan(`"${output.query}"`)} (${output.results.length} results, ${output.total_time_ms}ms, engines: ${output.engines_used.join(', ')})`;
  lines.push(header);

  if (output.warning) {
    lines.push('');
    lines.push(chalk.yellow(`  Warning: ${output.warning}`));
  }

  if (output.error) {
    lines.push('');
    lines.push(chalk.red(`  Error: ${output.error}`));
    return lines.join('\n');
  }

  if (output.results.length === 0) {
    lines.push('');
    lines.push(chalk.dim('  No results found'));
    return lines.join('\n');
  }

  for (let i = 0; i < output.results.length; i++) {
    const r = output.results[i];
    const domain = domainFromUrl(r.url);
    const score = r.relevance_score.toFixed(2);
    lines.push('');
    lines.push(`  ${chalk.bold(`[${i + 1}]`)} ${chalk.white(r.title)} ${chalk.dim(`- ${domain}`)} ${chalk.green(`(score: ${score})`)}`);
    lines.push(`      ${chalk.dim(truncate(r.snippet, SNIPPET_MAX_LENGTH))}`);
  }

  return lines.join('\n');
}

export function formatFetchResult(output: FetchOutput): string {
  const lines: string[] = [];

  lines.push(`Fetch: ${chalk.cyan(output.url)}`);

  if (output.error) {
    lines.push('');
    lines.push(chalk.red(`  Error: ${output.error}`));
    return lines.join('\n');
  }

  lines.push('');

  const markdownLines = output.markdown.split('\n');
  const preview = markdownLines.slice(0, 3).join('\n');
  const indented = preview.split('\n').map(l => `  ${l}`).join('\n');
  lines.push(indented);

  lines.push('');
  lines.push(chalk.dim(`  [cached: ${output.cached}, ${output.markdown.length} chars]`));

  return lines.join('\n');
}

export function formatCrawlResult(output: CrawlOutput, seedUrl: string): string {
  const lines: string[] = [];

  lines.push(`Crawl: ${chalk.cyan(seedUrl)} (${output.crawled} pages crawled, ${output.total_found} found)`);

  if (output.error) {
    lines.push('');
    lines.push(chalk.red(`  Error: ${output.error}`));
    return lines.join('\n');
  }

  if (output.pages.length === 0) {
    lines.push('');
    lines.push(chalk.dim('  No pages crawled'));
    return lines.join('\n');
  }

  for (let i = 0; i < output.pages.length; i++) {
    const p = output.pages[i];
    const path = pathFromUrl(p.url, seedUrl);
    lines.push(`  ${chalk.bold(`[${i + 1}]`)} ${chalk.white(path)} ${chalk.dim(`(depth: ${p.depth}, ${p.markdown.length} chars)`)}`);
  }

  return lines.join('\n');
}

export function formatMapResult(output: MapOutput, seedUrl: string): string {
  const lines: string[] = [];

  lines.push(`Map: ${chalk.cyan(seedUrl)} (${output.urls.length} URLs found, sitemap: ${output.sitemap_found ? 'yes' : 'no'})`);

  if (output.error) {
    lines.push('');
    lines.push(chalk.red(`  Error: ${output.error}`));
    return lines.join('\n');
  }

  if (output.urls.length === 0) {
    lines.push('');
    lines.push(chalk.dim('  No URLs found'));
    return lines.join('\n');
  }

  for (let i = 0; i < output.urls.length; i++) {
    const path = pathFromUrl(output.urls[i], seedUrl);
    lines.push(`  ${chalk.bold(`[${i + 1}]`)} ${chalk.white(path)}`);
  }

  return lines.join('\n');
}

export function formatExtractResult(output: ExtractOutput): string {
  const lines: string[] = [];

  const sourceLabel = output.source_url ? ` ${chalk.cyan(output.source_url)}` : '';
  lines.push(`Extract:${sourceLabel} (mode: ${chalk.yellow(output.mode)})`);

  if (output.error) {
    lines.push('');
    lines.push(chalk.red(`  Error: ${output.error}`));
    return lines.join('\n');
  }

  lines.push('');

  if (output.mode === 'tables' && Array.isArray(output.data)) {
    for (const table of output.data as TableData[]) {
      if (table.headers.length === 0) continue;
      const headerRow = '  | ' + table.headers.join(' | ') + ' |';
      const sepRow = '  | ' + table.headers.map(h => '-'.repeat(Math.max(h.length, 4))).join(' | ') + ' |';
      lines.push(headerRow);
      lines.push(sepRow);
      for (const row of table.rows) {
        const cells = table.headers.map(h => row[h] ?? '');
        lines.push('  | ' + cells.join(' | ') + '|');
      }
    }
  } else if (output.mode === 'selector') {
    if (Array.isArray(output.data)) {
      for (const item of output.data) {
        lines.push(`  ${item}`);
      }
    } else {
      lines.push(`  ${String(output.data)}`);
    }
  } else if (output.mode === 'metadata') {
    const meta = output.data as MetadataData;
    if (meta.title) lines.push(`  ${chalk.bold('Title:')} ${meta.title}`);
    if (meta.description) lines.push(`  ${chalk.bold('Description:')} ${meta.description}`);
    if (meta.author) lines.push(`  ${chalk.bold('Author:')} ${meta.author}`);
    if (meta.date) lines.push(`  ${chalk.bold('Date:')} ${meta.date}`);
    if (meta.keywords && meta.keywords.length > 0) {
      lines.push(`  ${chalk.bold('Keywords:')} ${meta.keywords.join(', ')}`);
    }
  } else if (output.mode === 'schema') {
    const data = output.data as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      lines.push(`  ${chalk.bold(key + ':')} ${String(value)}`);
    }
  }

  return lines.join('\n');
}

export function formatCacheResult(output: CacheOutput): string {
  const lines: string[] = [];

  if (output.error) {
    lines.push(chalk.red(`Error: ${output.error}`));
    return lines.join('\n');
  }

  if (output.stats) {
    lines.push('Cache Statistics:');
    lines.push(`  ${chalk.bold('Total URLs:')}  ${output.stats.total_urls}`);
    lines.push(`  ${chalk.bold('Total Size:')}  ${output.stats.total_size_mb.toFixed(2)} MB`);
    lines.push(`  ${chalk.bold('Oldest:')}      ${output.stats.oldest}`);
    lines.push(`  ${chalk.bold('Newest:')}      ${output.stats.newest}`);
    return lines.join('\n');
  }

  if (output.cleared !== undefined) {
    lines.push(`${chalk.green(String(output.cleared))} cache entries cleared`);
    return lines.join('\n');
  }

  if (output.results) {
    if (output.results.length === 0) {
      lines.push(chalk.dim('No cached results found'));
      return lines.join('\n');
    }
    for (let i = 0; i < output.results.length; i++) {
      const r = output.results[i];
      lines.push(`  ${chalk.bold(`[${i + 1}]`)} ${chalk.cyan(r.url)}`);
      lines.push(`      ${chalk.white(r.title)} ${chalk.dim(`(cached ${r.fetched_at})`)}`);
    }
    return lines.join('\n');
  }

  return chalk.dim('No output');
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
