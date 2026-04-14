export const extractor = {
  name: 'both-extractor',
  canHandle(url) {
    return url.includes('both-fixture.example');
  },
  extract(html, url) {
    return {
      title: 'Both Extracted',
      markdown: html.substring(0, 50),
      metadata: {},
      links: [],
      images: [],
      extractor: 'site-specific',
    };
  },
};

export const searchEngine = {
  name: 'both-search',
  async search(query, options) {
    return [
      {
        title: `Both result for ${query}`,
        url: 'https://both-fixture.example/result',
        snippet: 'A combined plugin result',
        relevance_score: 0.85,
        engine: 'both-search',
      },
    ];
  },
};
