export const searchEngine = {
  name: 'example-search-engine',
  async search(query) {
    return [
      {
        title: `Example result for ${query}`,
        url: 'https://example.com/search-engine-example',
        snippet: 'Minimal search engine plugin example.',
        relevance_score: 1,
        engine: 'example-search-engine',
      },
    ];
  },
};
