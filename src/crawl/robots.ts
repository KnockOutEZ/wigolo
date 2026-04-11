interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

export class RobotsParser {
  private rules: RobotsRule[] = [];
  private crawlDelay: number | null = null;

  constructor(robotsTxt: string) {
    this.parse(robotsTxt);
  }

  private parse(text: string): void {
    const lines = text.split('\n');
    let inWildcardAgent = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();

      if (line.match(/^user-agent:\s*\*/i)) {
        inWildcardAgent = true;
        continue;
      }

      if (line.match(/^user-agent:/i) && !line.match(/^user-agent:\s*\*/i)) {
        inWildcardAgent = false;
        continue;
      }

      if (!inWildcardAgent) continue;

      const disallowMatch = line.match(/^disallow:\s*(.*)/i);
      if (disallowMatch) {
        const path = disallowMatch[1].trim();
        if (path) {
          this.rules.push({ type: 'disallow', path });
        }
        continue;
      }

      const allowMatch = line.match(/^allow:\s*(.*)/i);
      if (allowMatch) {
        const path = allowMatch[1].trim();
        if (path) {
          this.rules.push({ type: 'allow', path });
        }
        continue;
      }

      const delayMatch = line.match(/^crawl-delay:\s*(\d+(?:\.\d+)?)/i);
      if (delayMatch) {
        this.crawlDelay = parseFloat(delayMatch[1]);
      }
    }
  }

  isAllowed(path: string): boolean {
    let bestMatch: RobotsRule | null = null;
    let bestLength = -1;

    for (const rule of this.rules) {
      if (path.startsWith(rule.path)) {
        if (rule.path.length > bestLength || (rule.path.length === bestLength && rule.type === 'allow')) {
          bestMatch = rule;
          bestLength = rule.path.length;
        }
      }
    }

    if (!bestMatch) return true;
    return bestMatch.type === 'allow';
  }

  getCrawlDelay(): number | null {
    return this.crawlDelay;
  }
}
