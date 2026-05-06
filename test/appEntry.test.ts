import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

describe('app HTML entry points', () => {
  it('keeps a marketing-style root index.html', () => {
    const path = resolve(root, 'client/index.html');
    expect(existsSync(path)).toBe(true);
    const html = readFileSync(path, 'utf8');
    expect(html).not.toContain('/src/main.tsx');
  });

  it.each([
    ['client/voice.html', '/voice.html'],
    ['client/voice/index.html', '/voice/'],
    ['client/dashboard/index.html', '/dashboard/'],
  ])('serves the runtime app from %s for %s', (entryPath) => {
    const path = resolve(root, entryPath);
    expect(existsSync(path)).toBe(true);
    const html = readFileSync(path, 'utf8');
    expect(html).toContain('/src/main.tsx');
    expect(html).toContain('id="root"');
  });
});
