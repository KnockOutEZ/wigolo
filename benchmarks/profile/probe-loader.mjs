/**
 * Module-load hook for the profiling spike.
 *
 * Appends a probe-registration line to the two modules that own an ONNX call
 * boundary. Appending to the SOURCE (rather than importing those modules from
 * the preload) means the ONNX runtime is still loaded lazily, exactly as in
 * production — eagerly importing it in the preload would move the very cost we
 * are trying to measure.
 *
 * Note: `module.register` hooks run on a separate thread, so this file cannot
 * see `globalThis.__wgProbe`. It only rewrites source; all recording happens on
 * the main thread inside the appended line.
 */

const PATCH = {
  'embedding/fastembed-provider.js':
    "\n;globalThis.__wgProbe?.wrapProto(FastembedEmbedProvider.prototype,'embed','onnx_embed');" +
    "\n;globalThis.__wgProbe?.wrapProto(FastembedEmbedProvider.prototype,'warmup','onnx_embed_warmup');\n",
  'search/reranker/transformers-rerank-provider.js':
    "\n;globalThis.__wgProbe?.wrapProto(TransformersRerankProvider.prototype,'rerank','onnx_rerank');" +
    "\n;globalThis.__wgProbe?.wrapProto(TransformersRerankProvider.prototype,'warmup','onnx_rerank_warmup');\n",
};

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  for (const [suffix, tail] of Object.entries(PATCH)) {
    if (url.endsWith(suffix) && result.source != null) {
      result.source = String(result.source) + tail;
      break;
    }
  }
  return result;
}
