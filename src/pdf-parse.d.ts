// Minimal ambient declaration for pdf-parse@2.x. The package ships its own
// .d.cts but the legacy shim was pinned to the v1 API
// (`default(buffer): Promise<{ text }>`) which no longer exists. v2 exposes
// a `PDFParse` class with `.getText(params)` → `{ text }`.
//
// Keep this surface minimal — we only call `new PDFParse({ data })` +
// `.getText({})` from src/extraction/v1/extract-provider.ts.
declare module 'pdf-parse' {
  export interface TextResult {
    text: string;
  }

  export interface ParseParameters {
    [key: string]: unknown;
  }

  export interface LoadParameters {
    data?: Buffer | Uint8Array;
    url?: string;
    [key: string]: unknown;
  }

  export class PDFParse {
    constructor(options: LoadParameters);
    getText(params?: ParseParameters): Promise<TextResult>;
    destroy(): Promise<void>;
  }
}
