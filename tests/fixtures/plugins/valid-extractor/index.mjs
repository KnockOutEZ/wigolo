export const extractor = {
  name: 'test-extractor',
  canHandle(url) {
    return url.includes('test-fixture.example');
  },
  extract(html, url) {
    return {
      title: 'Test Extracted',
      markdown: html.substring(0, 100),
      metadata: {},
      links: [],
      images: [],
      extractor: 'site-specific',
    };
  },
};
