import { createLogger } from '../logger.js';
import type { BrowserType } from '../types.js';

const log = createLogger('fetch');

export type SelectionStrategy = 'round-robin' | 'hostname-hash' | 'random';

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

export class BrowserSelector {
  private readonly types: BrowserType[];
  private readonly strategy: SelectionStrategy;
  private roundRobinIndex = 0;

  constructor(types: BrowserType[], strategy?: SelectionStrategy) {
    if (types.length === 0) {
      throw new Error('BrowserSelector requires at least one browser type');
    }
    this.types = [...types];
    this.strategy = strategy ?? 'round-robin';
    log.debug('browser selector initialized', {
      types: this.types,
      strategy: this.strategy,
    });
  }

  select(): BrowserType {
    switch (this.strategy) {
      case 'round-robin':
        return this.selectRoundRobin();
      case 'random':
        return this.selectRandom();
      case 'hostname-hash':
        // Without a hostname, fall back to round-robin
        return this.selectRoundRobin();
      default:
        return this.selectRoundRobin();
    }
  }

  selectForHostname(hostname: string): BrowserType {
    if (this.strategy === 'hostname-hash' && hostname) {
      return this.selectByHostnameHash(hostname);
    }
    return this.select();
  }

  getTypes(): BrowserType[] {
    return [...this.types];
  }

  getStrategy(): SelectionStrategy {
    return this.strategy;
  }

  reset(): void {
    this.roundRobinIndex = 0;
  }

  private selectRoundRobin(): BrowserType {
    const type = this.types[this.roundRobinIndex % this.types.length];
    this.roundRobinIndex++;
    return type;
  }

  private selectRandom(): BrowserType {
    const index = Math.floor(Math.random() * this.types.length);
    return this.types[index];
  }

  private selectByHostnameHash(hostname: string): BrowserType {
    const hash = hashString(hostname);
    const index = hash % this.types.length;
    return this.types[index];
  }
}
