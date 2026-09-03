/*
 * The published `wigolo/extraction` surface (SD7 capture seam).
 *
 * Deliberately two functions, not the pipeline: the caller is the app's page-capture
 * seam, which runs on the navigation path inside the DB-owning child and turns a
 * settled page into the body `recordVisit` stores. Re-exporting `pipeline.ts` would
 * drag the provider/registry graph — and a native module with it — onto that path for
 * an HTML string it already has. A symbol lands here only with a measured named import
 * site outside core.
 */
export { htmlToMarkdown } from './markdown.js';
export { extractMetadata } from './metadata.js';
