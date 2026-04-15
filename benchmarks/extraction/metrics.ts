import { createLogger } from '../../src/logger.js';
import { tokenize, longestCommonSubsequence, tokenOverlap } from './tokenizer.js';
import type { MetricResult } from './types.js';

const log = createLogger('extract');

export function computePrecision(extracted: string, golden: string): number {
  try {
    const extractedTokens = tokenize(extracted);
    const goldenTokens = tokenize(golden);
    if (extractedTokens.length === 0 || goldenTokens.length === 0) return 0;

    const { precision } = tokenOverlap(extractedTokens, goldenTokens);
    return precision;
  } catch (err) {
    log.warn('computePrecision failed', { error: String(err) });
    return 0;
  }
}

export function computeRecall(extracted: string, golden: string): number {
  try {
    const extractedTokens = tokenize(extracted);
    const goldenTokens = tokenize(golden);
    if (extractedTokens.length === 0 || goldenTokens.length === 0) return 0;

    const { recall } = tokenOverlap(extractedTokens, goldenTokens);
    return recall;
  } catch (err) {
    log.warn('computeRecall failed', { error: String(err) });
    return 0;
  }
}

export function computeF1(extracted: string, golden: string): number {
  try {
    const p = computePrecision(extracted, golden);
    const r = computeRecall(extracted, golden);
    if (p + r === 0) return 0;
    return (2 * p * r) / (p + r);
  } catch (err) {
    log.warn('computeF1 failed', { error: String(err) });
    return 0;
  }
}

export function computeRougeL(extracted: string, golden: string): number {
  try {
    const extractedTokens = tokenize(extracted);
    const goldenTokens = tokenize(golden);
    if (extractedTokens.length === 0 || goldenTokens.length === 0) return 0;

    const lcsLen = longestCommonSubsequence(extractedTokens, goldenTokens);
    if (lcsLen === 0) return 0;

    const precision = lcsLen / extractedTokens.length;
    const recall = lcsLen / goldenTokens.length;

    if (precision + recall === 0) return 0;
    return (2 * precision * recall) / (precision + recall);
  } catch (err) {
    log.warn('computeRougeL failed', { error: String(err) });
    return 0;
  }
}

export function countHeadings(markdown: string): number {
  try {
    if (!markdown) return 0;
    const matches = markdown.match(/^#{1,6}\s+/gm);
    return matches ? matches.length : 0;
  } catch (err) {
    log.warn('countHeadings failed', { error: String(err) });
    return 0;
  }
}

export function countLinks(markdown: string): number {
  try {
    if (!markdown) return 0;
    const matches = markdown.match(/(?<!!)\[[^\]]*\]\([^)]+\)/g);
    return matches ? matches.length : 0;
  } catch (err) {
    log.warn('countLinks failed', { error: String(err) });
    return 0;
  }
}

export function computeMetrics(extracted: string, golden: string): MetricResult {
  try {
    const precision = computePrecision(extracted, golden);
    const recall = computeRecall(extracted, golden);
    const f1 = computeF1(extracted, golden);
    const rougeL = computeRougeL(extracted, golden);

    const headingCountActual = countHeadings(extracted);
    const headingCountExpected = countHeadings(golden);
    const linkCountActual = countLinks(extracted);
    const linkCountExpected = countLinks(golden);

    return {
      precision,
      recall,
      f1,
      rougeL,
      headingCountMatch: headingCountActual === headingCountExpected,
      headingCountExpected,
      headingCountActual,
      linkCountMatch: linkCountActual === linkCountExpected,
      linkCountExpected,
      linkCountActual,
    };
  } catch (err) {
    log.warn('computeMetrics failed', { error: String(err) });
    return {
      precision: 0,
      recall: 0,
      f1: 0,
      rougeL: 0,
      headingCountMatch: false,
      headingCountExpected: 0,
      headingCountActual: 0,
      linkCountMatch: false,
      linkCountExpected: 0,
      linkCountActual: 0,
    };
  }
}
