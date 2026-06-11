// New-session destination catalog + creation. The daemon is the trusted
// side: Discord and Slack destinations come from the real channel
// catalogs (`openclaw message channel list`), never from recent session
// rows (threads/DMs/stale targets); web/no-chat sessions are created
// locally; real Discord threads are created through
// `openclaw message thread create`; Slack threads are started by
// posting a starter message and binding the session to its ts. A
// provider without real creatable channels is omitted from the catalog
// instead of being shown as a disabled/unsupported placeholder.

import { describe, expect, it, vi } from 'vitest';
import {
  buildChannelNewSessionDestinationProvider,
  buildNewSessionCreateResponse,
  createDiscordNewSession,
  createSlackNewSession,
  createWebchatNewSession,
  createWebchatOnlyNewSessionDestinationsCatalog,
  defaultNewSessionThreadName,
  extractDiscordThreadIdFromOutput,
  extractSlackThreadTsFromOutput,
  getNewSessionDestinationsWithOpenClaw,
  validateNewSessionCreateRequest,
  NEW_SESSION_THREAD_STARTER_MESSAGE,
} from '../daemon/src/newSession';
import { shouldDeliverReplyForChatTarget } from '../daemon/src/chatSession';
import type { NewSessionDestinationOption } from '../daemon/src/protocol';

vi.mock('@roamhq/wrtc', () => ({ default: {} }));

vi.mock('../daemon/src/signal.js', () => ({
  SignalClient: class SignalClient {
    on() {
      return this;
    }

    subscribe() {}
    close() {}
    sendSignal = vi.fn(async () => {});
  },
}));

vi.mock('simple-peer', () => ({
  default: class SimplePeer {
    destroyed = false;
    on() {
      return this;
    }
    signal() {}
    send() {}
    destroy() {
      this.destroyed = true;
    }
  },
}));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DISCORD_DESTINATIONS: NewSessionDestinationOption[] = [
  { id: 'discord:channel:100', target: 'channel:100', label: '#general', group: 'Claw HQ' },
];
const SLACK_DESTINATIONS: NewSessionDestinationOption[] = [
  { id: 'slack:channel:C123', target: 'channel:C123', label: '#general', group: 'Claw HQ' },
];

describe('new-session destination catalog', () => {
  it('always offers an available local webchat destination first', async () => {
    const catalog = await getNewSessionDestinationsWithOpenClaw({
      loadDiscordDestinations: async () => DISCORD_DESTINATIONS,
      loadSlackDestinations: async () => SLACK_DESTINATIONS,
    });
    expect(catalog.providers[0]).toEqual({
      id: 'webchat',
      label: 'Web only (no chat channel)',
      kind: 'local',
      status: 'available',
      destinations: [],
    });
  });

  it('serves Discord and Slack from their real channel catalogs', async () => {
    const catalog = await getNewSessionDestinationsWithOpenClaw({
      loadDiscordDestinations: async () => DISCORD_DESTINATIONS,
      loadSlackDestinations: async () => SLACK_DESTINATIONS,
    });
    expect(catalog.providers.map((provider) => provider.id)).toEqual(['webchat', 'discord', 'slack']);
    const [, discord, slack] = catalog.providers;
    expect(discord.label).toBe('Discord');
    expect(discord.status).toBe('available');
    expect(discord.destinations).toEqual(DISCORD_DESTINATIONS);
    expect(slack.label).toBe('Slack');
    expect(slack.status).toBe('available');
    expect(slack.destinations).toEqual(SLACK_DESTINATIONS);
  });

  it('omits a provider whose channel catalog is empty or failing instead of faking channels', async () => {
    const emptySlack = await getNewSessionDestinationsWithOpenClaw({
      loadDiscordDestinations: async () => DISCORD_DESTINATIONS,
      loadSlackDestinations: async () => [],
    });
    expect(emptySlack.providers.map((provider) => provider.id)).toEqual(['webchat', 'discord']);

    const failingDiscord = await getNewSessionDestinationsWithOpenClaw({
      loadDiscordDestinations: async () => {
        throw new Error('openclaw discord unavailable');
      },
      loadSlackDestinations: async () => SLACK_DESTINATIONS,
    });
    expect(failingDiscord.providers.map((provider) => provider.id)).toEqual(['webchat', 'slack']);
  });

  it('falls back to webchat only when no channel catalog is available', async () => {
    const catalog = await getNewSessionDestinationsWithOpenClaw({
      loadDiscordDestinations: async () => {
        throw new Error('openclaw unavailable');
      },
      loadSlackDestinations: async () => {
        throw new Error('openclaw unavailable');
      },
    });
    expect(catalog.providers).toEqual(createWebchatOnlyNewSessionDestinationsCatalog('t').providers);
  });

  it('builds available channel providers only when destinations exist', () => {
    expect(buildChannelNewSessionDestinationProvider('discord', DISCORD_DESTINATIONS)).toEqual({
      id: 'discord',
      label: 'Discord',
      kind: 'channel',
      status: 'available',
      destinations: DISCORD_DESTINATIONS,
    });
    expect(buildChannelNewSessionDestinationProvider('slack', [])).toBeUndefined();
  });
});

describe('new-session create validation', () => {
  it('accepts webchat requests and defaults the agent to main', () => {
    expect(validateNewSessionCreateRequest({ requestId: 'req-1', providerId: 'webchat' })).toEqual({
      ok: true,
      providerId: 'webchat',
      agent: 'main',
    });
    expect(validateNewSessionCreateRequest({ requestId: 'req-1', providerId: 'webchat', agent: ' kamaji ' })).toEqual({
      ok: true,
      providerId: 'webchat',
      agent: 'kamaji',
    });
  });

  it('accepts discord requests with a destination target and optional account', () => {
    expect(
      validateNewSessionCreateRequest({ requestId: 'req-1', providerId: 'discord', target: ' channel:parent-1 ' }),
    ).toEqual({
      ok: true,
      providerId: 'discord',
      agent: 'main',
      target: 'channel:parent-1',
    });
    expect(
      validateNewSessionCreateRequest({
        requestId: 'req-1',
        providerId: 'discord',
        agent: 'kamaji',
        target: 'channel:parent-1',
        accountId: 'acct-a',
      }),
    ).toEqual({
      ok: true,
      providerId: 'discord',
      agent: 'kamaji',
      target: 'channel:parent-1',
      accountId: 'acct-a',
    });
  });

  it('accepts slack requests with a parent-channel target only', () => {
    expect(
      validateNewSessionCreateRequest({ requestId: 'req-1', providerId: 'slack', target: 'channel:C123' }),
    ).toEqual({
      ok: true,
      providerId: 'slack',
      agent: 'main',
      target: 'channel:C123',
    });
    // Slack threads are created under a parent channel; user/DM targets
    // are never creatable destinations.
    expect(
      validateNewSessionCreateRequest({ requestId: 'req-1', providerId: 'slack', target: 'user:U123' }),
    ).toEqual({
      ok: false,
      message: 'invalid_new_session_target',
    });
  });

  it('rejects missing request ids, unsupported providers, unsafe agents, and bad targets', () => {
    expect(validateNewSessionCreateRequest({ providerId: 'webchat' })).toEqual({
      ok: false,
      message: 'invalid_new_session_request',
    });
    expect(validateNewSessionCreateRequest({ requestId: '  ', providerId: 'webchat' })).toEqual({
      ok: false,
      message: 'invalid_new_session_request',
    });
    expect(validateNewSessionCreateRequest({ requestId: 'req-1', providerId: 'telegram', target: 'chat:1' })).toEqual({
      ok: false,
      message: 'new_session_destination_unsupported',
    });
    expect(validateNewSessionCreateRequest({ requestId: 'req-1', providerId: 'webchat', agent: 'evil:agent' })).toEqual({
      ok: false,
      message: 'invalid_new_session_agent',
    });
    expect(validateNewSessionCreateRequest({ requestId: 'req-1', providerId: 'discord' })).toEqual({
      ok: false,
      message: 'invalid_new_session_target',
    });
    expect(validateNewSessionCreateRequest({ requestId: 'req-1', providerId: 'slack' })).toEqual({
      ok: false,
      message: 'invalid_new_session_target',
    });
    expect(
      validateNewSessionCreateRequest({ requestId: 'req-1', providerId: 'discord', target: 'channel:x; rm -rf /' }),
    ).toEqual({
      ok: false,
      message: 'invalid_new_session_target',
    });
    expect(
      validateNewSessionCreateRequest({
        requestId: 'req-1',
        providerId: 'discord',
        target: 'channel:parent-1',
        accountId: 'bad account',
      }),
    ).toEqual({
      ok: false,
      message: 'invalid_new_session_account',
    });
  });
});

describe('webchat session creation', () => {
  it('mints a UUID session id with a webchat session key and no delivery route', () => {
    const session = createWebchatNewSession({ agent: 'main' });
    expect(session.sessionId).toMatch(UUID_PATTERN);
    expect(session.sessionKey).toBe(`agent:main:webchat:session:${session.sessionId}`);
    expect(session.agent).toBe('main');
    expect(session.channel).toBe('webchat');
    expect(session.target).toBeUndefined();
    expect(session.displayLabel).toBe('New web session');
  });

  it('builds a sessions.created response carrying the request id', async () => {
    const response = await buildNewSessionCreateResponse(
      { requestId: 'req-9', providerId: 'webchat' },
      { generateSessionId: () => 'fixed-session', now: () => new Date('2026-06-10T01:02:03.000Z') },
    );
    expect(response).toEqual({
      t: 'sessions.created',
      requestId: 'req-9',
      session: {
        sessionId: 'fixed-session',
        sessionKey: 'agent:main:webchat:session:fixed-session',
        agent: 'main',
        channel: 'webchat',
        lastActivity: '2026-06-10T01:02:03.000Z',
        displayLabel: 'New web session',
      },
    });
  });

  it('builds a sessions.create.error response for unsupported destinations', async () => {
    await expect(
      buildNewSessionCreateResponse({ requestId: 'req-10', providerId: 'telegram', target: 'chat:1' }),
    ).resolves.toEqual({
      t: 'sessions.create.error',
      requestId: 'req-10',
      message: 'new_session_destination_unsupported',
    });
  });
});

describe('discord session creation', () => {
  it('creates a thread via the OpenClaw CLI and binds the session to it', async () => {
    const execOpenClaw = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: true, thread: { id: '111222333', name: 'My thread' } }),
    }));
    const session = await createDiscordNewSession({
      agent: 'main',
      target: 'channel:parent-1',
      accountId: 'acct-a',
      execOpenClaw,
      generateSessionId: () => 'fixed-session',
      now: () => new Date('2026-06-10T01:02:03.000Z'),
    });

    expect(execOpenClaw).toHaveBeenCalledWith('openclaw', [
      'message', 'thread', 'create',
      '--channel', 'discord',
      '--target', 'channel:parent-1',
      '--thread-name', defaultNewSessionThreadName(new Date('2026-06-10T01:02:03.000Z')),
      '--message', NEW_SESSION_THREAD_STARTER_MESSAGE,
      '--json',
      '--account', 'acct-a',
    ]);
    expect(session).toEqual({
      sessionId: 'fixed-session',
      sessionKey: 'agent:main:discord:channel:111222333',
      agent: 'main',
      channel: 'discord',
      target: 'channel:111222333',
      accountId: 'acct-a',
      lastActivity: '2026-06-10T01:02:03.000Z',
      displayLabel: defaultNewSessionThreadName(new Date('2026-06-10T01:02:03.000Z')),
    });
  });

  it('omits --account when no account id is selected', async () => {
    const execOpenClaw = vi.fn(async () => ({ stdout: '{"threadId":"42"}' }));
    const session = await createDiscordNewSession({
      agent: 'main',
      target: 'channel:parent-1',
      execOpenClaw,
      now: () => new Date('2026-06-10T01:02:03.000Z'),
    });
    expect(execOpenClaw.mock.calls[0][1]).not.toContain('--account');
    expect(session.accountId).toBeUndefined();
    expect(session.target).toBe('channel:42');
  });

  it('extracts thread ids from the output shapes OpenClaw is known to emit', () => {
    expect(extractDiscordThreadIdFromOutput('{"threadId":"123"}')).toBe('123');
    expect(extractDiscordThreadIdFromOutput('{"thread_id":456}')).toBe('456');
    expect(extractDiscordThreadIdFromOutput('{"thread":{"id":"789","name":"x"}}')).toBe('789');
    expect(
      extractDiscordThreadIdFromOutput('{"ok":true,"data":{"result":{"thread":{"id":"999"}}}}'),
    ).toBe('999');
    expect(
      extractDiscordThreadIdFromOutput('starting…\n{"payload":{"threadId":"31337"}}\ndone'),
    ).toBe('31337');
    expect(extractDiscordThreadIdFromOutput('')).toBeUndefined();
    expect(extractDiscordThreadIdFromOutput('not json')).toBeUndefined();
    expect(extractDiscordThreadIdFromOutput('{"ok":true,"messageId":"5"}')).toBeUndefined();
    // Unsafe ids never reach the session key.
    expect(extractDiscordThreadIdFromOutput('{"threadId":"evil id; rm"}')).toBeUndefined();
  });

  it('fails with clear codes when the CLI errors or returns no thread id', async () => {
    await expect(
      createDiscordNewSession({
        agent: 'main',
        target: 'channel:parent-1',
        execOpenClaw: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toMatchObject({ name: 'NewSessionCreateError', code: 'discord_thread_create_failed' });

    await expect(
      createDiscordNewSession({
        agent: 'main',
        target: 'channel:parent-1',
        execOpenClaw: async () => ({ stdout: '{"ok":true}' }),
      }),
    ).rejects.toMatchObject({ name: 'NewSessionCreateError', code: 'discord_thread_id_unresolved' });
  });

  it('builds a sessions.created response with a fresh UUID for discord requests', async () => {
    const response = await buildNewSessionCreateResponse(
      { requestId: 'req-11', providerId: 'discord', target: 'channel:parent-1', accountId: 'acct-a' },
      {
        execOpenClaw: async () => ({ stdout: '{"thread":{"id":"t-900"}}' }),
        now: () => new Date('2026-06-10T01:02:03.000Z'),
      },
    );
    expect(response.t).toBe('sessions.created');
    const session = (response as { session: { sessionId: string; sessionKey: string; target?: string; channel?: string; accountId?: string } }).session;
    expect(session.sessionId).toMatch(UUID_PATTERN);
    expect(session.sessionKey).toBe('agent:main:discord:channel:t-900');
    expect(session.channel).toBe('discord');
    expect(session.target).toBe('channel:t-900');
    expect(session.accountId).toBe('acct-a');
  });

  it('builds sessions.create.error responses from creation failures', async () => {
    await expect(
      buildNewSessionCreateResponse(
        { requestId: 'req-12', providerId: 'discord', target: 'channel:parent-1' },
        {
          execOpenClaw: async () => {
            throw new Error('boom');
          },
        },
      ),
    ).resolves.toEqual({
      t: 'sessions.create.error',
      requestId: 'req-12',
      message: 'discord_thread_create_failed',
    });

    await expect(
      buildNewSessionCreateResponse(
        { requestId: 'req-13', providerId: 'discord', target: 'channel:parent-1' },
        { execOpenClaw: async () => ({ stdout: 'no json here' }) },
      ),
    ).resolves.toEqual({
      t: 'sessions.create.error',
      requestId: 'req-13',
      message: 'discord_thread_id_unresolved',
    });
  });
});

describe('slack session creation', () => {
  const NOW = new Date('2026-06-10T01:02:03.000Z');

  it('starts a thread by posting a starter message and binds the session to its ts', async () => {
    const execOpenClaw = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: true, ts: '1710000000.000100' }),
    }));
    const session = await createSlackNewSession({
      agent: 'main',
      target: 'channel:C123',
      accountId: 'acct-a',
      execOpenClaw,
      generateSessionId: () => 'fixed-session',
      now: () => NOW,
    });

    expect(execOpenClaw).toHaveBeenCalledWith('openclaw', [
      'message', 'send',
      '--channel', 'slack',
      '--target', 'channel:C123',
      '--message', `${defaultNewSessionThreadName(NOW)} — ${NEW_SESSION_THREAD_STARTER_MESSAGE}`,
      '--json',
      '--account', 'acct-a',
    ]);
    expect(session).toEqual({
      sessionId: 'fixed-session',
      // OpenClaw's own Slack thread session-key shape; chatSession.ts
      // derives `--thread-id` delivery routing from the thread suffix.
      sessionKey: 'agent:main:slack:channel:C123:thread:1710000000.000100',
      agent: 'main',
      channel: 'slack',
      target: 'channel:C123',
      accountId: 'acct-a',
      lastActivity: '2026-06-10T01:02:03.000Z',
      displayLabel: defaultNewSessionThreadName(NOW),
    });
  });

  it('omits --account when no account id is selected', async () => {
    const execOpenClaw = vi.fn(async () => ({ stdout: '{"ts":"1710000000.000100"}' }));
    const session = await createSlackNewSession({
      agent: 'main',
      target: 'channel:C123',
      execOpenClaw,
      now: () => NOW,
    });
    expect(execOpenClaw.mock.calls[0][1]).not.toContain('--account');
    expect(session.accountId).toBeUndefined();
  });

  it('extracts the thread ts from the output shapes OpenClaw is known to emit', () => {
    expect(extractSlackThreadTsFromOutput('{"ts":"1710000000.000100"}')).toBe('1710000000.000100');
    expect(extractSlackThreadTsFromOutput('{"message":{"ts":"1710000000.000200"}}')).toBe('1710000000.000200');
    expect(extractSlackThreadTsFromOutput('{"data":{"result":{"messageTs":"1710000000.000300"}}}')).toBe('1710000000.000300');
    expect(extractSlackThreadTsFromOutput('{"payload":{"messageId":"1710000000.000400"}}')).toBe('1710000000.000400');
    expect(
      extractSlackThreadTsFromOutput('sending…\n{"result":{"thread_ts":"1710000000.000500"}}\ndone'),
    ).toBe('1710000000.000500');
    // An explicit thread ts wins over the message's own ts.
    expect(
      extractSlackThreadTsFromOutput('{"threadTs":"1710000000.000001","ts":"1710000000.000002"}'),
    ).toBe('1710000000.000001');
    expect(extractSlackThreadTsFromOutput('')).toBeUndefined();
    expect(extractSlackThreadTsFromOutput('not json')).toBeUndefined();
    // Non-ts-shaped ids cannot address a Slack thread.
    expect(extractSlackThreadTsFromOutput('{"messageId":"ABC123"}')).toBeUndefined();
    // Numeric ts values would silently lose precision — rejected.
    expect(extractSlackThreadTsFromOutput('{"ts":1710000000.0001}')).toBeUndefined();
  });

  it('fails with clear codes when the CLI errors or returns no usable ts', async () => {
    await expect(
      createSlackNewSession({
        agent: 'main',
        target: 'channel:C123',
        execOpenClaw: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toMatchObject({ name: 'NewSessionCreateError', code: 'slack_thread_create_failed' });

    await expect(
      createSlackNewSession({
        agent: 'main',
        target: 'channel:C123',
        execOpenClaw: async () => ({ stdout: '{"ok":true}' }),
      }),
    ).rejects.toMatchObject({ name: 'NewSessionCreateError', code: 'slack_thread_ts_unresolved' });
  });

  it('builds sessions.created and sessions.create.error responses for slack requests', async () => {
    const response = await buildNewSessionCreateResponse(
      { requestId: 'req-20', providerId: 'slack', target: 'channel:C123' },
      {
        execOpenClaw: async () => ({ stdout: '{"message":{"ts":"1710000000.000100"}}' }),
        now: () => NOW,
      },
    );
    expect(response.t).toBe('sessions.created');
    const session = (response as { session: { sessionId: string; sessionKey: string; target?: string; channel?: string } }).session;
    expect(session.sessionId).toMatch(UUID_PATTERN);
    expect(session.sessionKey).toBe('agent:main:slack:channel:C123:thread:1710000000.000100');
    expect(session.channel).toBe('slack');
    expect(session.target).toBe('channel:C123');

    await expect(
      buildNewSessionCreateResponse(
        { requestId: 'req-21', providerId: 'slack', target: 'channel:C123' },
        { execOpenClaw: async () => ({ stdout: 'no json here' }) },
      ),
    ).resolves.toEqual({
      t: 'sessions.create.error',
      requestId: 'req-21',
      message: 'slack_thread_ts_unresolved',
    });
  });
});

describe('voice reply delivery for webchat sessions', () => {
  it('skips --deliver for webchat and internal main sessions', () => {
    expect(shouldDeliverReplyForChatTarget({ sessionId: 'uuid', channel: 'webchat' })).toBe(false);
    expect(
      shouldDeliverReplyForChatTarget({ sessionId: 'uuid', sessionKey: 'agent:main:webchat:session:uuid' }),
    ).toBe(false);
    expect(shouldDeliverReplyForChatTarget({ sessionId: 'agent:main:main' })).toBe(false);
  });

  it('keeps mandatory delivery for external chat channels and unknown routes', () => {
    expect(shouldDeliverReplyForChatTarget({ sessionId: 'uuid', channel: 'discord' })).toBe(true);
    expect(shouldDeliverReplyForChatTarget({ sessionId: 'uuid', channel: 'slack' })).toBe(true);
    expect(
      shouldDeliverReplyForChatTarget({ sessionId: 'uuid', sessionKey: 'agent:main:discord:channel:t-1' }),
    ).toBe(true);
    expect(
      shouldDeliverReplyForChatTarget({
        sessionId: 'uuid',
        sessionKey: 'agent:main:slack:channel:C123:thread:1710000000.000100',
      }),
    ).toBe(true);
    expect(shouldDeliverReplyForChatTarget({ sessionId: 'c44d9502-ce71-46b1-9b15-5d548004544a' })).toBe(true);
  });
});

describe('DaemonPeer rendezvous new-session lane', () => {
  function makeRendezvousPeer() {
    return {
      peer: {
        destroyed: false,
        send: vi.fn(),
      },
      remoteId: 'phone-1',
      timeout: setTimeout(() => undefined, 10_000),
      connected: true,
      initiator: false,
      acceptedOffer: true,
      acceptedAnswer: false,
      recentSessionsInterval: null,
      protocolUnsupported: false,
    };
  }

  it('serves the destination catalog and creates webchat, discord, and slack sessions on the rendezvous lane', async () => {
    const { DaemonPeer } = await import('../daemon/src/peer');
    const execOpenClaw = vi.fn(async (_command: string, args: string[]) =>
      args.includes('thread')
        ? { stdout: '{"thread":{"id":"t-777"}}' }
        : { stdout: '{"ts":"1710000000.000100"}' });
    const discordDestinationsProvider = vi.fn(async (): Promise<NewSessionDestinationOption[]> => [
      { id: 'discord:channel:100', target: 'channel:100', label: '#general', group: 'Claw HQ' },
    ]);
    const slackDestinationsProvider = vi.fn(async (): Promise<NewSessionDestinationOption[]> => [
      { id: 'slack:channel:C123', target: 'channel:C123', label: '#general', group: 'Claw HQ' },
    ]);
    const peer = new DaemonPeer({
      peerId: 'host-1',
      signalServer: 'https://signal.example',
      iceServers: [],
      newSessionDiscordDestinationsProvider: discordDestinationsProvider,
      newSessionSlackDestinationsProvider: slackDestinationsProvider,
      newSessionCreateResponder: (msg) => buildNewSessionCreateResponse(msg, { execOpenClaw }),
      onReady: vi.fn(),
    });
    const rendezvousPeer = makeRendezvousPeer();
    const handle = (data: string) =>
      (peer as unknown as { handleRendezvousData(rp: unknown, data: unknown): void }).handleRendezvousData(
        rendezvousPeer,
        data,
      );

    handle(JSON.stringify({ t: 'sessions.destinations.request' }));
    await vi.waitFor(() => {
      expect(rendezvousPeer.peer.send).toHaveBeenCalledTimes(1);
    });
    const immediateDestinations = JSON.parse(rendezvousPeer.peer.send.mock.calls[0][0] as string);
    expect(immediateDestinations.t).toBe('sessions.destinations');
    expect(immediateDestinations.catalog.providers.map((provider: { id: string }) => provider.id)).toEqual([
      'webchat',
    ]);
    await vi.waitFor(() => {
      expect(rendezvousPeer.peer.send).toHaveBeenCalledTimes(2);
    });
    const destinations = JSON.parse(rendezvousPeer.peer.send.mock.calls[1][0] as string);
    expect(destinations.t).toBe('sessions.destinations');
    expect(destinations.catalog.providers.map((provider: { id: string }) => provider.id)).toEqual([
      'webchat',
      'discord',
      'slack',
    ]);
    // Both channel providers come from injected real channel catalogs,
    // not recent-session rows.
    expect(discordDestinationsProvider).toHaveBeenCalledTimes(1);
    expect(slackDestinationsProvider).toHaveBeenCalledTimes(1);
    const discordProvider = destinations.catalog.providers[1];
    expect(discordProvider.status).toBe('available');
    expect(discordProvider.destinations).toEqual([
      { id: 'discord:channel:100', target: 'channel:100', label: '#general', group: 'Claw HQ' },
    ]);
    const slackProvider = destinations.catalog.providers[2];
    expect(slackProvider.status).toBe('available');
    expect(slackProvider.destinations).toEqual([
      { id: 'slack:channel:C123', target: 'channel:C123', label: '#general', group: 'Claw HQ' },
    ]);

    handle(JSON.stringify({ t: 'sessions.create.request', requestId: 'req-1', providerId: 'webchat' }));
    await vi.waitFor(() => {
      expect(rendezvousPeer.peer.send).toHaveBeenCalledTimes(3);
    });
    const created = JSON.parse(rendezvousPeer.peer.send.mock.calls[2][0] as string);
    expect(created.t).toBe('sessions.created');
    expect(created.requestId).toBe('req-1');
    expect(created.session.sessionId).toMatch(UUID_PATTERN);
    expect(created.session.channel).toBe('webchat');
    // Creation never opens a voice room by itself — the browser still
    // sends rendezvous.join with the returned sessionId.
    expect((peer as unknown as { activeRoomIds: string[] }).activeRoomIds).toEqual([]);

    handle(
      JSON.stringify({
        t: 'sessions.create.request',
        requestId: 'req-2',
        providerId: 'discord',
        target: 'channel:parent-1',
        accountId: 'acct-a',
      }),
    );
    await vi.waitFor(() => {
      expect(rendezvousPeer.peer.send).toHaveBeenCalledTimes(4);
    });
    const discordCreated = JSON.parse(rendezvousPeer.peer.send.mock.calls[3][0] as string);
    expect(discordCreated.t).toBe('sessions.created');
    expect(discordCreated.requestId).toBe('req-2');
    expect(discordCreated.session.sessionId).toMatch(UUID_PATTERN);
    expect(discordCreated.session.channel).toBe('discord');
    expect(discordCreated.session.target).toBe('channel:t-777');
    expect(discordCreated.session.sessionKey).toBe('agent:main:discord:channel:t-777');
    expect(discordCreated.session.accountId).toBe('acct-a');
    expect(execOpenClaw).toHaveBeenCalledTimes(1);

    handle(JSON.stringify({ t: 'sessions.create.request', requestId: 'req-3', providerId: 'slack', target: 'channel:C123' }));
    await vi.waitFor(() => {
      expect(rendezvousPeer.peer.send).toHaveBeenCalledTimes(5);
    });
    const slackCreated = JSON.parse(rendezvousPeer.peer.send.mock.calls[4][0] as string);
    expect(slackCreated.t).toBe('sessions.created');
    expect(slackCreated.requestId).toBe('req-3');
    expect(slackCreated.session.sessionId).toMatch(UUID_PATTERN);
    expect(slackCreated.session.channel).toBe('slack');
    expect(slackCreated.session.target).toBe('channel:C123');
    expect(slackCreated.session.sessionKey).toBe('agent:main:slack:channel:C123:thread:1710000000.000100');
    expect(execOpenClaw).toHaveBeenCalledTimes(2);

    clearTimeout(rendezvousPeer.timeout);
    peer.close();
  });
});
