// Real Discord channel catalog for the New Session picker. The daemon
// discovers parent channels through `openclaw message channel list
// --channel discord --json`; recent session rows (threads/DMs/stale
// targets) never feed the picker. Output parsing is defensive across
// the wrapper shapes OpenClaw versions emit, type filtering fails
// closed, and guild ids are inferred from OpenClaw config — never
// hard-coded.

import { describe, expect, it, vi } from 'vitest';
import {
  buildDiscordChannelDestinations,
  discordChannelDestinationLabel,
  extractDiscordGuildIdsFromConfig,
  listDiscordChannelDestinations,
  loadDiscordGuildIdsFromOpenClawConfig,
  parseDiscordChannelListOutput,
} from '../daemon/src/discordChannels';

describe('discord channel list parsing', () => {
  it('parses a bare array of channels', () => {
    const entries = parseDiscordChannelListOutput(
      JSON.stringify([
        { id: '100', name: 'general', type: 0 },
        { id: '101', name: 'help', type: 0, guildId: '900000000000000001', guildName: 'Claw HQ' },
      ]),
    );
    expect(entries).toEqual([
      { id: '100', name: 'general' },
      { id: '101', name: 'help', guildId: '900000000000000001', guildName: 'Claw HQ' },
    ]);
  });

  it('parses channels nested under wrapper objects and log-prefixed output', () => {
    expect(
      parseDiscordChannelListOutput('{"channels":[{"id":"1","name":"general","type":0}]}'),
    ).toEqual([{ id: '1', name: 'general' }]);
    expect(
      parseDiscordChannelListOutput('{"ok":true,"payload":{"data":{"channels":[{"id":"2","name":"dev","type":"text"}]}}}'),
    ).toEqual([{ id: '2', name: 'dev' }]);
    expect(
      parseDiscordChannelListOutput('connecting…\n{"result":[{"id":"3","name":"ops","type":0}]}\ndone'),
    ).toEqual([{ id: '3', name: 'ops' }]);
  });

  it('keeps only thread-capable parent channels: text, announcement, forum, media', () => {
    const entries = parseDiscordChannelListOutput(
      JSON.stringify([
        { id: '1', name: 'text', type: 0 },
        { id: '2', name: 'announcements', type: 5 },
        { id: '3', name: 'forum', type: 15 },
        { id: '4', name: 'media', type: 16 },
        { id: '10', name: 'voice', type: 2 },
        { id: '11', name: 'stage', type: 13 },
        { id: '12', name: 'category', type: 4 },
        { id: '13', name: 'directory', type: 14 },
      ]),
    );
    expect(entries.map((entry) => entry.id)).toEqual(['1', '2', '3', '4']);
  });

  it('excludes DMs and prior thread targets so the picker never shows them', () => {
    const entries = parseDiscordChannelListOutput(
      JSON.stringify([
        { id: '1', name: 'general', type: 0 },
        { id: '20', type: 1 },
        { id: '21', type: 3 },
        { id: '22', name: 'old voice session', type: 11 },
        { id: '23', name: 'news thread', type: 10 },
        { id: '24', name: 'private thread', type: 12 },
        { id: '25', name: 'flagged-thread', isThread: true },
        { id: '26', name: 'flagged-dm', dm: true },
        { id: '27', recipient: { id: 'user-1' } },
        { id: '28', name: 'string thread', type: 'public_thread' },
        { id: '29', name: 'string dm', type: 'dm' },
        { id: '30', name: 'string voice', type: 'voice' },
      ]),
    );
    expect(entries).toEqual([{ id: '1', name: 'general' }]);
  });

  it('keeps untyped {id,name} entries but fails closed on unrecognized explicit types', () => {
    const entries = parseDiscordChannelListOutput(
      JSON.stringify([
        { id: '1', name: 'minimal-listing' },
        { id: '2', name: 'mystery', type: 'holocron' },
        { id: '3', name: 'numeric mystery', type: 99 },
        { id: '4', name: 'string text', type: 'guild_text' },
      ]),
    );
    expect(entries.map((entry) => entry.id)).toEqual(['1', '4']);
  });

  it('rejects unsafe ids and dedupes, preferring entries that carry a name', () => {
    const entries = parseDiscordChannelListOutput(
      JSON.stringify({
        channels: [
          { id: 'evil id; rm', name: 'nope', type: 0 },
          { id: '7', type: 0 },
          { id: '7', name: 'named-later', type: 0 },
        ],
      }),
    );
    expect(entries).toEqual([{ id: '7', name: 'named-later' }]);
  });

  it('returns nothing for empty, non-JSON, or channel-free output', () => {
    expect(parseDiscordChannelListOutput('')).toEqual([]);
    expect(parseDiscordChannelListOutput('not json')).toEqual([]);
    expect(parseDiscordChannelListOutput('{"ok":true}')).toEqual([]);
  });
});

describe('discord channel destinations', () => {
  it('labels channels with human names and groups them by guild', () => {
    expect(discordChannelDestinationLabel({ id: '1', name: 'general' })).toBe('#general');
    expect(discordChannelDestinationLabel({ id: '1', name: '#already' })).toBe('#already');
    expect(discordChannelDestinationLabel({ id: '42' })).toBe('channel 42');

    expect(
      buildDiscordChannelDestinations([
        { id: '2', name: 'zeta', guildName: 'Claw HQ' },
        { id: '1', name: 'alpha', guildName: 'Claw HQ' },
        { id: '3', name: 'solo' },
      ]),
    ).toEqual([
      { id: 'discord:channel:3', target: 'channel:3', label: '#solo' },
      { id: 'discord:channel:1', target: 'channel:1', label: '#alpha', group: 'Claw HQ' },
      { id: 'discord:channel:2', target: 'channel:2', label: '#zeta', group: 'Claw HQ' },
    ]);
  });
});

describe('guild id inference from OpenClaw config', () => {
  it('finds guildId keys and guilds maps/arrays under channels.discord without hard-coding', () => {
    expect(
      extractDiscordGuildIdsFromConfig({
        channels: { discord: { guildId: '900000000000000001' } },
      }),
    ).toEqual(['900000000000000001']);
    expect(
      extractDiscordGuildIdsFromConfig({
        channels: {
          discord: {
            guilds: {
              '900000000000000002': { channels: { general: { allow: true } } },
              'not-a-guild': {},
            },
          },
        },
      }),
    ).toEqual(['900000000000000002']);
    expect(
      extractDiscordGuildIdsFromConfig({
        discord: { accounts: { default: { defaultGuildId: '900000000000000003', guilds: ['900000000000000004'] } } },
      }),
    ).toEqual(['900000000000000003', '900000000000000004']);
  });

  it('ignores other channels, non-snowflake values, and unreadable config', async () => {
    expect(extractDiscordGuildIdsFromConfig({ channels: { slack: { guildId: '900000000000000009' } } })).toEqual([]);
    expect(extractDiscordGuildIdsFromConfig({ channels: { discord: { guildId: 'main-guild' } } })).toEqual([]);
    expect(extractDiscordGuildIdsFromConfig(null)).toEqual([]);

    await expect(
      loadDiscordGuildIdsFromOpenClawConfig({
        readConfig: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).resolves.toEqual([]);
    await expect(
      loadDiscordGuildIdsFromOpenClawConfig({ readConfig: async () => 'not json' }),
    ).resolves.toEqual([]);
    await expect(
      loadDiscordGuildIdsFromOpenClawConfig({
        readConfig: async () => JSON.stringify({ channels: { discord: { guildId: '900000000000000005' } } }),
      }),
    ).resolves.toEqual(['900000000000000005']);
  });
});

describe('listDiscordChannelDestinations', () => {
  it('uses the bare channel list call when it returns channels', async () => {
    const execOpenClaw = vi.fn(async () => ({
      stdout: JSON.stringify({ channels: [{ id: '1', name: 'general', type: 0 }] }),
    }));
    const loadGuildIds = vi.fn(async () => ['900000000000000001']);

    const destinations = await listDiscordChannelDestinations({ execOpenClaw, loadGuildIds });

    expect(execOpenClaw).toHaveBeenCalledTimes(1);
    expect(execOpenClaw).toHaveBeenCalledWith('openclaw', [
      'message', 'channel', 'list', '--channel', 'discord', '--json',
    ]);
    expect(loadGuildIds).not.toHaveBeenCalled();
    expect(destinations).toEqual([
      { id: 'discord:channel:1', target: 'channel:1', label: '#general' },
    ]);
  });

  it('falls back to config-inferred guild ids when the bare call yields nothing', async () => {
    const execOpenClaw = vi.fn(async (_command: string, args: string[]) => {
      const guildFlag = args.indexOf('--guild-id');
      if (guildFlag === -1) throw new Error('guild id required');
      const guildId = args[guildFlag + 1];
      return {
        stdout: JSON.stringify([
          { id: `${guildId.slice(-1)}00`, name: `general-${guildId.slice(-1)}`, type: 0, guild_id: guildId },
        ]),
      };
    });
    const destinations = await listDiscordChannelDestinations({
      execOpenClaw,
      loadGuildIds: async () => ['900000000000000001', '900000000000000002', 'not-a-guild'],
    });

    expect(execOpenClaw).toHaveBeenCalledTimes(3);
    expect(execOpenClaw.mock.calls[1][1]).toEqual([
      'message', 'channel', 'list', '--channel', 'discord', '--json', '--guild-id', '900000000000000001',
    ]);
    expect(destinations).toEqual([
      { id: 'discord:channel:100', target: 'channel:100', label: '#general-1' },
      { id: 'discord:channel:200', target: 'channel:200', label: '#general-2' },
    ]);
  });

  it('returns an empty catalog when OpenClaw provides no real channels anywhere', async () => {
    const execOpenClaw = vi.fn(async () => {
      throw new Error('discord not configured');
    });
    await expect(
      listDiscordChannelDestinations({ execOpenClaw, loadGuildIds: async () => ['900000000000000001'] }),
    ).resolves.toEqual([]);
    await expect(
      listDiscordChannelDestinations({
        execOpenClaw: async () => ({ stdout: '{"channels":[]}' }),
        loadGuildIds: async () => {
          throw new Error('no config');
        },
      }),
    ).resolves.toEqual([]);
  });
});
