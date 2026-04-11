declare module 'pdf-parse' {
  export class PDFParse {
    constructor(filePath?: string);
    load(source: Buffer | string): Promise<void>;
    getText(): Promise<string>;
    getInfo(): Promise<Record<string, unknown>>;
    destroy(): void;
  }
}
