export interface ExampleSearchResult {
  title: string;
  url: string;
  snippet: string;
  relevance_score: number;
  engine: string;
}

export declare const searchEngine: {
  name: string;
  search(query: string): Promise<ExampleSearchResult[]>;
};
