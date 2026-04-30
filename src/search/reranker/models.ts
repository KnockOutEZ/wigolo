export interface ModelEntry {
  id: string;
  modelUrl: string;
  modelSha256: string;
  tokenizerUrl: string;
  tokenizerSha256: string;
  configUrl: string;
  configSha256: string;
  approxBytes: number;
}

export const MODELS: Record<string, ModelEntry> = {
  'bge-reranker-v2-m3': {
    id: 'bge-reranker-v2-m3',
    modelUrl:
      'https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX/resolve/main/onnx/model_quantized.onnx',
    modelSha256: '912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d',
    tokenizerUrl:
      'https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX/resolve/main/tokenizer.json',
    tokenizerSha256: '8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3',
    configUrl:
      'https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX/resolve/main/tokenizer_config.json',
    configSha256: 'b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80',
    approxBytes: 570_727_094,
  },
  'ms-marco-MiniLM-L-12-v2': {
    id: 'ms-marco-MiniLM-L-12-v2',
    modelUrl:
      'https://huggingface.co/Xenova/ms-marco-MiniLM-L-12-v2/resolve/main/onnx/model_quantized.onnx',
    modelSha256: 'c5551b3e446396364913c5ad79e9c8411a76d26523b7d87232052ae6c0d0c7fd',
    tokenizerUrl:
      'https://huggingface.co/Xenova/ms-marco-MiniLM-L-12-v2/resolve/main/tokenizer.json',
    tokenizerSha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
    configUrl:
      'https://huggingface.co/Xenova/ms-marco-MiniLM-L-12-v2/resolve/main/tokenizer_config.json',
    configSha256: '0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53',
    approxBytes: 34_201_341,
  },
};

const ALIASES: Record<string, string> = {
  'minilm-l12': 'ms-marco-MiniLM-L-12-v2',
};

export function resolveModelId(input: string): string {
  return ALIASES[input] ?? input;
}

export function getModel(id: string): ModelEntry {
  const resolved = resolveModelId(id);
  const entry = MODELS[resolved];
  if (!entry) {
    throw new Error(`Unknown reranker model: ${id} (resolved to ${resolved})`);
  }
  return entry;
}
