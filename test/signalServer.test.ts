import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNAL_SERVER } from '../daemon/src/signalServer';

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('signal server config', () => {
  it('defaults to the hosted rambly broker', () => {
    expect(DEFAULT_SIGNAL_SERVER).toBe('https://api.rambly.app');
  });

  it('does not read signal server overrides at module load', () => {
    expect(source('../daemon/src/signalServer.ts')).not.toMatch(/process\.env/);
  });

  it('daemon CLI accepts custom signal and ICE overrides', () => {
    const cliSrc = source('../daemon/src/cli.ts');
    expect(cliSrc).toMatch(/'signal-server'/);
    expect(cliSrc).toMatch(/'ice-servers-json'/);
    const transportSrc = source('../daemon/src/transportConfig.ts');
    expect(transportSrc).toMatch(/CT_SIGNAL_SERVER/);
    expect(transportSrc).toMatch(/CT_ICE_SERVERS_JSON/);
  });

  it('daemon entrypoint passes resolved transport into DaemonPeer', () => {
    const indexSrc = source('../daemon/src/index.ts');
    expect(indexSrc).toMatch(/signalServer: cli\.signalServer/);
    expect(indexSrc).toMatch(/iceServers: cli\.iceServers/);
  });
});
