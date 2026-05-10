import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

const publicDocs = [
  'README.md',
  'AGENT-INSTALL.md',
  'docs/voice-handoff.md',
  'docs/agent-install-troubleshooting.md',
  'docs/agent-install-upgrade-repair.md',
];

const userFacingSources = [
  'client/src/screens/Dashboard.tsx',
  'client/src/screens/Driving.tsx',
  'client/src/screens/Settings.tsx',
  'client/src/rtc/RtcContext.tsx',
  ...publicDocs,
];

describe('daemon capability/protocol copy', () => {
  it('maps unsupported daemon protocol details to an update-daemon user notice instead of raw codes', () => {
    const source = read('client/src/screens/Dashboard.tsx');

    expect(source).toContain('formatDaemonRendezvousDetail(rtc.detail)');
    expect(source).toContain("if (detail === 'unsupported_daemon_protocol')");
    expect(source).toContain('Daemon protocol/capability mismatch. Update the installed daemon.');
    expect(source).not.toContain('Daemon rendezvous error: {rtc.detail}');
  });

  it('documents that the browser side is current by definition and daemon upgrades resolve capability mismatches', () => {
    for (const relativePath of publicDocs) {
      const source = read(relativePath);
      expect(source, relativePath).toMatch(/browser\s+client\s+is\s+current\s+by\s+definition/i);
      expect(source, relativePath).toMatch(/update\s+the\s+installed\s+daemon/i);
      expect(source, relativePath).toMatch(/daemon\s+protocol\/capability\s+mismatch/i);
    }
  });

  it('does not regress to stale-client or ambiguous mismatch wording in user-facing docs and UI copy', () => {
    const browser = 'cl' + 'ient';
    const service = 'dae' + 'mon';
    const mismatch = 'mis' + 'match';
    const staleBrowserPattern = new RegExp(
      `old\\s+${browser}|${browser}\\s+is\\s+old|${browser}\\s+may\\s+be\\s+stale`,
      'i',
    );
    const ambiguousMismatchPattern = new RegExp(
      `${browser}\\s*\\/\\s*${service}\\s+${mismatch}|${browser}-${service}\\s+${mismatch}`,
      'i',
    );

    for (const relativePath of userFacingSources) {
      const source = read(relativePath);
      expect(source, relativePath).not.toMatch(staleBrowserPattern);
      expect(source, relativePath).not.toMatch(ambiguousMismatchPattern);
    }
  });
});
