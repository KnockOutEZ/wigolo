export const searchEngine = {
  name: 'test-search',
  async search(query, options) {
    return [
      {
        title: `Test result for ${query}`,
        url: 'https://test-fixture.example/result',
        snippet: 'A test search result',
        relevance_score: 0.9,
        engine: 'test-search',
      },
    ];
  },
};
