import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PackageJson {
  version?: string;
}

export function getPackageVersion(): string {
  try {
    const pkg = require('../../../package.json') as PackageJson;
    return pkg.version ?? '0.0.0';
  } catch {
    return 'unknown';
  }
}
