const MAX_QUERY_LENGTH = 200;
const CLAUSE_SEPARATORS = ['. ', '? ', '! ', '; ', ', and ', ', or ', ' - ', ' — '];

export function decomposeQuery(query: string): string[] {
  if (query.length <= MAX_QUERY_LENGTH) {
    return [query];
  }

  let parts = [query];

  for (const sep of CLAUSE_SEPARATORS) {
    if (parts.every(p => p.length <= MAX_QUERY_LENGTH)) break;

    parts = parts.flatMap(p => {
      if (p.length <= MAX_QUERY_LENGTH) return [p];
      return p.split(sep).map(s => s.trim()).filter(Boolean);
    });
  }

  parts = parts.flatMap(p => {
    if (p.length <= MAX_QUERY_LENGTH) return [p];
    return splitAtWordBoundary(p);
  });

  return parts;
}

function splitAtWordBoundary(text: string): string[] {
  const chunks: string[] = [];
  const words = text.split(' ');
  let current = '';

  for (const word of words) {
    if (current.length + word.length + 1 > MAX_QUERY_LENGTH && current) {
      chunks.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
