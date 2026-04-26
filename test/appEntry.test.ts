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

  it('serves the voice app from /voice.html', () => {
    const path = resolve(root, 'client/voice.html');
    expect(existsSync(path)).toBe(true);
    const html = readFileSync(path, 'utf8');
    expect(html).toContain('/src/main.tsx');
    expect(html).toContain('id="root"');
  });

  it('preserves search and hash from /voice when redirecting to /voice.html', () => {
    const path = resolve(root, 'client/voice/index.html');
    expect(existsSync(path)).toBe(true);
    const html = readFileSync(path, 'utf8');
    expect(html).toContain("'/voice.html' + location.search + location.hash");
  });
});
