#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.WIGOLO_DATA_DIR ?? join(homedir(), '.wigolo');
const corpusPath = join(__dirname, '..', 'tests', 'fixtures', 'reranker-tokenizer-corpus.json');
const outPath = join(__dirname, '..', 'tests', 'fixtures', 'reranker-tokenizer-snapshot.json');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf-8'));
const MODELS = ['bge-reranker-v2-m3', 'ms-marco-MiniLM-L-12-v2'];
const MAX_LENGTH = 512;

const { AutoTokenizer, env } = await import('@xenova/transformers');
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = join(DATA_DIR, 'models');

const snapshot = { version: 1, maxLength: MAX_LENGTH, models: {} };
for (const modelId of MODELS) {
  const modelDir = join(DATA_DIR, 'models', modelId);
  if (!existsSync(modelDir)) {
    process.stderr.write(`SKIP ${modelId}: model dir ${modelDir} not present\n`);
    continue;
  }
  process.stderr.write(`tokenizing ${modelId}...\n`);
  const tok = await AutoTokenizer.from_pretrained(modelId, { local_files_only: true });
  snapshot.models[modelId] = {};
  for (const [bucket, pairs] of Object.entries(corpus.buckets)) {
    snapshot.models[modelId][bucket] = [];
    for (const { query, doc } of pairs) {
      const enc = tok(query, {
        text_pair: doc,
        max_length: MAX_LENGTH,
        truncation: true,
        padding: 'max_length',
        return_tensor: true,
      });
      const length = enc.input_ids.dims[1];
      const toArr = (a) => Array.from(a, (v) => Number(v));
      snapshot.models[modelId][bucket].push({
        input_ids: toArr(enc.input_ids.data),
        attention_mask: toArr(enc.attention_mask.data),
        token_type_ids: enc.token_type_ids ? toArr(enc.token_type_ids.data) : new Array(length).fill(0),
      });
    }
  }
}
writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
process.stderr.write(`wrote ${outPath}\n`);
