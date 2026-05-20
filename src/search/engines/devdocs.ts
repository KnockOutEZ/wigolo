import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../types.js';

// devdocs.io has no public full-text search endpoint suitable for cross-corpus
// search. Rather than fetching the ~1MB /docs.json index, we maintain a
// hardcoded slug table of the most-requested doc sets and short-circuit
// against query tokens. Real "docs" coverage comes from MDN + general fallback.
interface DocSlug {
  slug: string;
  aliases: string[];
  title: string;
  type: string;
}

const DOCS: DocSlug[] = [
  { slug: 'react', aliases: ['react', 'reactjs'], title: 'React', type: 'JavaScript library' },
  { slug: 'vue', aliases: ['vue', 'vuejs'], title: 'Vue.js', type: 'JavaScript framework' },
  { slug: 'angular', aliases: ['angular'], title: 'Angular', type: 'JavaScript framework' },
  { slug: 'svelte', aliases: ['svelte'], title: 'Svelte', type: 'JavaScript framework' },
  { slug: 'typescript', aliases: ['typescript', 'ts'], title: 'TypeScript', type: 'Language' },
  { slug: 'javascript', aliases: ['javascript', 'js'], title: 'JavaScript', type: 'Language' },
  { slug: 'node', aliases: ['node', 'nodejs'], title: 'Node.js', type: 'Runtime' },
  { slug: 'python~3.12', aliases: ['python', 'py'], title: 'Python 3.12', type: 'Language' },
  { slug: 'go', aliases: ['go', 'golang'], title: 'Go', type: 'Language' },
  { slug: 'rust', aliases: ['rust'], title: 'Rust', type: 'Language' },
  { slug: 'css', aliases: ['css'], title: 'CSS', type: 'Web standard' },
  { slug: 'html', aliases: ['html'], title: 'HTML', type: 'Web standard' },
  { slug: 'http', aliases: ['http'], title: 'HTTP', type: 'Protocol' },
  { slug: 'postgresql~16', aliases: ['postgres', 'postgresql', 'pg'], title: 'PostgreSQL 16', type: 'Database' },
  { slug: 'sqlite', aliases: ['sqlite'], title: 'SQLite', type: 'Database' },
  { slug: 'redis', aliases: ['redis'], title: 'Redis', type: 'Database' },
  { slug: 'docker', aliases: ['docker'], title: 'Docker', type: 'Tool' },
  { slug: 'git', aliases: ['git'], title: 'Git', type: 'Tool' },
  { slug: 'bash', aliases: ['bash', 'shell'], title: 'Bash', type: 'Shell' },
  { slug: 'nginx', aliases: ['nginx'], title: 'nginx', type: 'Web server' },
  { slug: 'webpack~5', aliases: ['webpack'], title: 'webpack 5', type: 'Bundler' },
  { slug: 'tailwindcss', aliases: ['tailwind', 'tailwindcss'], title: 'Tailwind CSS', type: 'CSS framework' },
];

export class DevDocsEngine implements SearchEngine {
  name = 'devdocs';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    const maxResults = options.maxResults ?? 10;
    const tokens = query
      .toLowerCase()
      .split(/[\s\-_]+/)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return [];

    const matched: DocSlug[] = [];
    for (const doc of DOCS) {
      if (doc.aliases.some((alias) => tokens.includes(alias))) {
        matched.push(doc);
      }
    }

    const limited = matched.slice(0, maxResults);
    const total = limited.length;
    const results: RawSearchResult[] = [];
    for (let i = 0; i < total; i++) {
      const doc = limited[i];
      results.push({
        title: doc.title,
        url: `https://devdocs.io/${doc.slug.split('~')[0]}`,
        snippet: `${doc.title} — ${doc.type}`,
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'devdocs',
      });
    }
    return results;
  }
}
