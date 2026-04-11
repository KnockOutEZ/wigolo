declare module 'pdf-parse' {
  interface PdfData { text: string; numpages: number; info: Record<string, unknown>; }
  export default function pdf(buffer: Buffer): Promise<PdfData>;
}
