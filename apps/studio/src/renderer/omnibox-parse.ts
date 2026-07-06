const SEARCH_URL = 'https://duckduckgo.com/?q=';
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/;

export function parseOmnibox(input: string): string {
  const text = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (!text.includes(' ')) {
    if (LOCAL_HOST.test(text)) return `http://${text}`;
    if (text.includes('.')) return `https://${text}`;
  }
  return `${SEARCH_URL}${encodeURIComponent(text)}`;
}
