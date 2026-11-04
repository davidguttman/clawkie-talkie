import { describe, expect, it } from 'vitest';
import { probeOpenClawCli } from '../daemon/src/openclawCliProbe';

describe('probeOpenClawCli', () => {
  it('stays quiet when openclaw --version succeeds', async () => {
    await expect(probeOpenClawCli(async () => true)).resolves.toEqual({ ok: true });
  });

  it('warns, and still allows startup, when the CLI is missing', async () => {
    const result = await probeOpenClawCli(async () => false);
    expect(result.ok).toBe(false);
    expect(result.warning).toContain('openclaw --version');
    expect(result.warning).toContain('~/.local/bin');
    expect(result.warning).toContain('npm run agent-install-preflight');
  });
});
