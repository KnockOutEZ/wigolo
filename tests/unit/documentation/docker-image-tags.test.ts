import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8');
const installationGuide = readFileSync(join(repoRoot, 'docs', 'installation.md'), 'utf-8');

describe('published Docker image tags', () => {
  it('documents the published browser-preloaded image tag', () => {
    expect(readme).toContain('ghcr.io/knockoutez/wigolo:latest-full');
    expect(installationGuide).toContain('ghcr.io/knockoutez/wigolo:latest-full');
  });

  it('does not present the nonexistent :full tag as a published image', () => {
    for (const document of [readme, installationGuide]) {
      expect(document).not.toContain('ghcr.io/knockoutez/wigolo:full');
    }
  });
});
