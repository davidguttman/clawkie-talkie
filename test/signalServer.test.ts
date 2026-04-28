import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_SERVER } from '../daemon/src/signalServer';

describe('signal server config', () => {
  it('defaults to the hosted rambly broker', () => {
    expect(DEFAULT_SIGNAL_SERVER).toBe('https://api.rambly.app');
  });

  it('does not read SIGNAL_SERVER from process.env at module load', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../daemon/src/signalServer.ts', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/process\.env\.SIGNAL_SERVER/);
  });

  it('the daemon CLI no longer accepts a signal-server flag or env override', () => {
    const indexSrc = readFileSync(
      fileURLToPath(new URL('../daemon/src/index.ts', import.meta.url)),
      'utf8',
    );
    expect(indexSrc).not.toMatch(/'signal-server'/);
    expect(indexSrc).not.toMatch(/SIGNAL_SERVER/);
  });

  it('the daemon peer no longer reads SIGNAL_SERVER from the environment', () => {
    const peerSrc = readFileSync(
      fileURLToPath(new URL('../daemon/src/peer.ts', import.meta.url)),
      'utf8',
    );
    expect(peerSrc).not.toMatch(/process\.env\.SIGNAL_SERVER/);
  });
});
