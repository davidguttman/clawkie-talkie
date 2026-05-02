import { describe, expect, it, vi } from 'vitest';
import { parseCli } from '../daemon/src/cli';
import { parseIceServersJson } from '../daemon/src/transportConfig';
import { parseClientIceServersJson } from '../client/src/rtc/client';

describe('daemon custom transport config', () => {
  it('keeps hosted defaults when CLI and env are unset', () => {
    const cli = parseCli([], {});
    expect(cli.signalServer).toBe('https://api.rambly.app');
    expect(cli.iceServers).toBeUndefined();
  });

  it('accepts signal server and ICE servers from env', () => {
    const cli = parseCli([], {
      CT_SIGNAL_SERVER: 'https://signal.example',
      CT_ICE_SERVERS_JSON: '[{"urls":"stun:stun.example:3478"}]',
    });
    expect(cli.signalServer).toBe('https://signal.example');
    expect(cli.iceServers).toEqual([{ urls: 'stun:stun.example:3478' }]);
  });

  it('lets CLI flags override env transport settings', () => {
    const cli = parseCli(
      [
        '--signal-server',
        'https://cli-signal.example',
        '--ice-servers-json',
        '[{"urls":"turn:turn.example:3478","username":"u","credential":"p"}]',
      ],
      {
        CT_SIGNAL_SERVER: 'https://env-signal.example',
        CT_ICE_SERVERS_JSON: '[{"urls":"stun:env.example:3478"}]',
      },
    );
    expect(cli.signalServer).toBe('https://cli-signal.example');
    expect(cli.iceServers).toEqual([
      { urls: 'turn:turn.example:3478', username: 'u', credential: 'p' },
    ]);
  });

  it('fails clearly for invalid ICE JSON before connecting', () => {
    expect(() => parseIceServersJson('nope', 'CT_ICE_SERVERS_JSON')).toThrow(
      /Invalid CT_ICE_SERVERS_JSON: expected JSON array of RTCIceServer objects/,
    );
    expect(() => parseCli(['--ice-servers-json', '{"urls":"stun:x"}'], {})).toThrow(
      /Invalid --ice-servers-json/,
    );
  });
});

describe('frontend custom ICE config', () => {
  it('parses VITE_ICE_SERVERS_JSON arrays', () => {
    expect(
      parseClientIceServersJson('[{"urls":["stun:one.example","stun:two.example"]}]'),
    ).toEqual([{ urls: ['stun:one.example', 'stun:two.example'] }]);
  });

  it('warns and falls back on invalid VITE_ICE_SERVERS_JSON', () => {
    const warn = vi.fn();
    expect(parseClientIceServersJson('{"urls":"stun:x"}', warn)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid VITE_ICE_SERVERS_JSON'),
    );
  });
});
