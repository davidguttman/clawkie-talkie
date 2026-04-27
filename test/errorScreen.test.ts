import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

describe('ErrorScreen bad session copy', () => {
  it('uses the approved copy for invalid handoff/session routes', () => {
    const source = readFileSync(
      resolve(root, 'client/src/screens/ErrorScreen.tsx'),
      'utf8',
    );

    expect(source).toContain("pill: 'SESSION UNAVAILABLE'");
    expect(source).toContain("headline: 'Clawkie can’t join this session'");
    expect(source).toContain(
      "body: 'The handoff details are missing or unavailable. Go back to your chat and open the voice link again.'",
    );

    expect(source).not.toContain('LINK ' + 'EXPIRED');
    expect(source).not.toContain("This session link isn't " + 'valid');
    expect(source).not.toContain(
      'Handoff links ex' + 'pire after ' + '15 ' + 'minutes',
    );
    expect(source).not.toMatch(/fr(?:)esh/);
  });
});
