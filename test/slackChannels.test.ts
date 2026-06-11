// Real Slack channel catalog for the New Session picker. The daemon
// discovers postable channels through `openclaw message channel list
// --channel slack --json`; recent session rows (threads/DMs/stale
// targets) never feed the picker. Output parsing is defensive across
// the wrapper shapes OpenClaw versions emit and DM/IM filtering fails
// closed on explicit type info.

import { describe, expect, it, vi } from 'vitest';
import {
  buildSlackChannelDestinations,
  listSlackChannelDestinations,
  parseSlackChannelListOutput,
  slackChannelDestinationLabel,
} from '../daemon/src/slackChannels';

describe('slack channel list parsing', () => {
  it('parses a bare array of channels', () => {
    const entries = parseSlackChannelListOutput(
      JSON.stringify([
        { id: 'C100', name: 'general', is_channel: true },
        { id: 'C101', name: 'help', type: 'public_channel', teamName: 'Claw HQ' },
      ]),
    );
    expect(entries).toEqual([
      { id: 'C100', name: 'general' },
      { id: 'C101', name: 'help', teamName: 'Claw HQ' },
    ]);
  });

  it('parses wrapped and log-prefixed output shapes', () => {
    const wrapped = parseSlackChannelListOutput(
      JSON.stringify({ data: { result: { channels: [{ id: 'C200', name: 'design' }] } } }),
    );
    expect(wrapped).toEqual([{ id: 'C200', name: 'design' }]);

    const logged = parseSlackChannelListOutput(
      `connecting…\n${JSON.stringify({ channels: [{ channel_id: 'C201', channel_name: 'ops' }] })}\ndone`,
    );
    expect(logged).toEqual([{ id: 'C201', name: 'ops' }]);
  });

  it('excludes IMs, multi-party IMs, archived conversations, and DM-shaped ids', () => {
    const entries = parseSlackChannelListOutput(
      JSON.stringify([
        { id: 'C100', name: 'general', is_channel: true },
        { id: 'D0ABCDEF1', name: 'dave dm' },
        { id: 'C300', name: 'someone', is_im: true },
        { id: 'C301', name: 'group dm', is_mpim: true },
        { id: 'C302', name: 'old times', is_channel: true, is_archived: true },
        { id: 'C303', type: 'im' },
        { id: 'C304', type: 'mpim' },
        { id: 'C305', user: 'U123' },
        { id: 'C306', recipient: { id: 'U999' } },
      ]),
    );
    expect(entries).toEqual([{ id: 'C100', name: 'general' }]);
  });

  it('fails closed on unknown explicit types but keeps minimal untyped listings', () => {
    const entries = parseSlackChannelListOutput(
      JSON.stringify([
        { id: 'C400', name: 'mystery', type: 'huddle' },
        { id: 'C401', name: 'plain' },
        { id: 'G402', name: 'legacy-private', is_group: true },
      ]),
    );
    expect(entries).toEqual([
      { id: 'C401', name: 'plain' },
      { id: 'G402', name: 'legacy-private' },
    ]);
  });

  it('drops unsafe ids and prefers entries that carry a channel name', () => {
    const entries = parseSlackChannelListOutput(
      JSON.stringify([
        { id: 'C500' },
        { id: 'C500', name: 'named' },
        { id: 'C5;rm -rf', name: 'evil' },
      ]),
    );
    expect(entries).toEqual([{ id: 'C500', name: 'named' }]);
  });

  it('reads workspace names from team/workspace fields', () => {
    const entries = parseSlackChannelListOutput(
      JSON.stringify([
        { id: 'C600', name: 'a', team: { id: 'T1', name: 'Claw HQ' } },
        { id: 'C601', name: 'b', team_name: 'Side Project' },
      ]),
    );
    expect(entries).toEqual([
      { id: 'C600', name: 'a', teamName: 'Claw HQ' },
      { id: 'C601', name: 'b', teamName: 'Side Project' },
    ]);
  });
});

describe('slack destination building', () => {
  it('labels channels with a leading # and falls back to the id', () => {
    expect(slackChannelDestinationLabel({ id: 'C1', name: 'general' })).toBe('#general');
    expect(slackChannelDestinationLabel({ id: 'C1', name: '#already' })).toBe('#already');
    expect(slackChannelDestinationLabel({ id: 'C1' })).toBe('channel C1');
  });

  it('builds channel:<id> targets grouped by workspace and sorted by label', () => {
    expect(
      buildSlackChannelDestinations([
        { id: 'C2', name: 'zebra', teamName: 'Claw HQ' },
        { id: 'C1', name: 'alpha', teamName: 'Claw HQ' },
        { id: 'C3', name: 'solo' },
      ]),
    ).toEqual([
      { id: 'slack:channel:C3', target: 'channel:C3', label: '#solo' },
      { id: 'slack:channel:C1', target: 'channel:C1', label: '#alpha', group: 'Claw HQ' },
      { id: 'slack:channel:C2', target: 'channel:C2', label: '#zebra', group: 'Claw HQ' },
    ]);
  });
});

describe('listSlackChannelDestinations', () => {
  it('lists channels via the OpenClaw CLI', async () => {
    const execOpenClaw = vi.fn(async () => ({
      stdout: JSON.stringify([{ id: 'C100', name: 'general', is_channel: true }]),
    }));
    const destinations = await listSlackChannelDestinations({ execOpenClaw });
    expect(execOpenClaw).toHaveBeenCalledWith('openclaw', [
      'message', 'channel', 'list', '--channel', 'slack', '--json',
    ]);
    expect(destinations).toEqual([
      { id: 'slack:channel:C100', target: 'channel:C100', label: '#general' },
    ]);
  });

  it('returns no destinations when the CLI fails instead of inventing channels', async () => {
    const destinations = await listSlackChannelDestinations({
      execOpenClaw: async () => {
        throw new Error('openclaw slack unavailable');
      },
    });
    expect(destinations).toEqual([]);
  });
});
