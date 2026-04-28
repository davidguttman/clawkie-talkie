import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLIENT_ORIGIN,
  resolveClientOrigin,
} from '../daemon/src/clientOrigin';

describe('resolveClientOrigin', () => {
  it('defaults to the public client origin when no CLI or env value is set', () => {
    expect(resolveClientOrigin(undefined, {} as NodeJS.ProcessEnv)).toBe(
      DEFAULT_CLIENT_ORIGIN,
    );
    expect(DEFAULT_CLIENT_ORIGIN).toBe('https://clawkietalkie.app');
  });

  it('treats a blank CLI value as absent and falls back to env', () => {
    expect(
      resolveClientOrigin('   ', {
        CT_CLIENT_ORIGIN: 'https://override.example',
      } as NodeJS.ProcessEnv),
    ).toBe('https://override.example');
  });

  it('treats a blank env value as absent and falls back to the default', () => {
    expect(
      resolveClientOrigin(undefined, {
        CT_CLIENT_ORIGIN: '   ',
      } as NodeJS.ProcessEnv),
    ).toBe(DEFAULT_CLIENT_ORIGIN);
  });

  it('prefers CLI over env when both are set', () => {
    expect(
      resolveClientOrigin('https://cli.example', {
        CT_CLIENT_ORIGIN: 'https://env.example',
      } as NodeJS.ProcessEnv),
    ).toBe('https://cli.example');
  });

  it('trims surrounding whitespace from CLI and env values', () => {
    expect(
      resolveClientOrigin('  https://cli.example  ', {} as NodeJS.ProcessEnv),
    ).toBe('https://cli.example');
    expect(
      resolveClientOrigin(undefined, {
        CT_CLIENT_ORIGIN: '  https://env.example  ',
      } as NodeJS.ProcessEnv),
    ).toBe('https://env.example');
  });
});
