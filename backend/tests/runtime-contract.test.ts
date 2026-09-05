import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const nodeRange = '>=24.0.0 <25.0.0';

describe('supported runtime contract', () => {
  it('keeps every workspace and CI on Node 24', () => {
    for (const path of ['package.json', 'backend/package.json', 'frontend/package.json']) {
      const manifest = JSON.parse(
        readFileSync(resolve(repositoryRoot, path), 'utf8'),
      ) as { engines?: { node?: string } };
      expect(manifest.engines?.node, path).toBe(nodeRange);
    }

    expect(readFileSync(resolve(repositoryRoot, '.nvmrc'), 'utf8').trim()).toBe('24');
    expect(readFileSync(resolve(repositoryRoot, '.npmrc'), 'utf8').trim())
      .toBe('engine-strict=true');
    expect(readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'))
      .toMatch(/node-version:\s*24(?:\s|$)/);
  });
});
