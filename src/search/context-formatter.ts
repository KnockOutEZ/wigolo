import { createLogger } from '../logger.js';
import type { SearchResultItem } from '../types.js';

const log = createLogger('search');

export function formatSearchContext(results: SearchResultItem[], maxTotalChars: number): string {
  if (results.length === 0 || maxTotalChars <= 0) {
    return '';
  }

  const blocks: string[] = [];
  let charsUsed = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const content = result.markdown_content || result.snippet || '';
    const header = `Source: ${result.title} (${result.url})`;
    const separator = '\n';
    const blockSeparator = i > 0 ? '\n\n' : '';

    const minBlockSize = blockSeparator.length + header.length + separator.length;

    if (i > 0 && charsUsed + minBlockSize >= maxTotalChars) {
      log.debug('context formatter stopping: next header exceeds budget', {
        resultIndex: i,
        charsUsed,
        maxTotalChars,
      });
      break;
    }

    const remainingBudget = maxTotalChars - charsUsed - blockSeparator.length - header.length - separator.length;

    let truncatedContent: string;
    if (remainingBudget <= 0) {
      const totalAvailable = maxTotalChars - charsUsed - blockSeparator.length;
      if (totalAvailable <= 0 && i > 0) break;
      const headerTruncated = totalAvailable > 3 ? header.slice(0, totalAvailable - 3) + '...' : header.slice(0, Math.max(totalAvailable, 0));
      blocks.push(blockSeparator + headerTruncated);
      charsUsed += blockSeparator.length + headerTruncated.length;
      break;
    } else if (content.length > remainingBudget) {
      const truncLen = Math.max(remainingBudget - 3, 0);
      truncatedContent = truncLen > 0 ? content.slice(0, truncLen) + '...' : '...';
      log.debug('context formatter truncated result content', {
        resultIndex: i,
        originalLength: content.length,
        truncatedTo: truncatedContent.length,
      });
    } else {
      truncatedContent = content;
    }

    const block = blockSeparator + header + separator + truncatedContent;
    blocks.push(block);
    charsUsed += block.length;

    if (charsUsed >= maxTotalChars) {
      break;
    }
  }

  return blocks.join('').trimEnd();
}
