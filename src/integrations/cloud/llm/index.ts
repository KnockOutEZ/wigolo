// Public barrel for the `wigolo/llm` subpath — the one-shot local-LLM seam.
//
// A CEILING, not a floor (the A4 rule): every name below has a named import
// site outside this repo. The ladder's internals — provider selection, the
// cloud adapters, the JSON path, the tier resolver — stay unexported, because a
// consumer reaching them could route a call this seam exists to keep honest.
// SD8's BYOK tool-calling loop is app-side and is not published here.
export { runLocalLlmText } from './one-shot.js';
export type {
  LocalCompletionOk,
  LocalCompletionRequest,
  LocalCompletionResult,
  LocalCompletionUnavailable,
  LocalCompletionUnavailableReason,
} from './one-shot.js';
