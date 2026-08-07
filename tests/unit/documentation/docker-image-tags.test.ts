import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8');
const installationGuide = readFileSync(join(repoRoot, 'docs', 'installation.md'), 'utf-8');

describe('published Docker image tags', () => {
  it('documents the published browser-preloaded image tag', () => {
    expect(readme).toContain('ghcr.io/knockoutez/wigolo:latest-full');
    expect(installationGuide).toContain('ghcr.io/knockoutez/wigolo:latest-full');
  });

  it('does not present the nonexistent :full tag as a published image', () => {
    expect(readme).not.toContain('`:full` preinstalls the browser engine');
  });
});
