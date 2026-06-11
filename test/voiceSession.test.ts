import { beforeEach, describe, expect, it, vi } from 'vitest';

const sttMocks = vi.hoisted(() => {
  function makeFakeSession(this: unknown, opts: unknown, cb: unknown) {
    const session: any = {
      opts,
      cb,
      sentAudio: [] as Uint8Array[],
      audioDoneCalls: 0,
      closedCalls: 0,
    };
    session.sendAudio = vi.fn((bytes: Uint8Array) => {
      session.sentAudio.push(bytes);
    });
    session.signalAudioDone = vi.fn(() => {
      session.audioDoneCalls += 1;
    });
    session.close = vi.fn(() => {
      session.closedCalls += 1;
    });
    return session;
  }

  return {
    inferCtor: vi.fn(makeFakeSession),
  };
});

const chatMocks = vi.hoisted(() => ({
  runChat: vi.fn(),
}));

const ttsMocks = vi.hoisted(() => {
  function makeFakeTtsSession(this: unknown, opts: unknown, cb: unknown) {
    const session: any = {
      opts,
      cb,
      cancel: vi.fn(),
    };
    return session;
  }

  return {
    inferTtsCtor: vi.fn(makeFakeTtsSession),
  };
});

vi.mock('../daemon/src/inferSttSession.js', () => ({
  OpenClawInferSttSession: sttMocks.inferCtor,
}));

vi.mock('../daemon/src/ttsSession.js', () => ({
  OpenClawInferTtsSession: ttsMocks.inferTtsCtor,
  TTS_SAMPLE_RATE: 24000,
}));

vi.mock('../daemon/src/chatSession.js', async (importOriginal) => ({
  // Keep the real pure deliver-flag derivation so webchat/no-chat
  // sessions exercise the same logic as production.
  shouldDeliverReplyForChatTarget:
    (await importOriginal<typeof import('../daemon/src/chatSession.js')>()).shouldDeliverReplyForChatTarget,
  runChat: chatMocks.runChat,
  ChatError: class ChatError extends Error {
    code: string;
    details?: { rootMessage?: string; stderr?: string; exitCode?: string };

    constructor(message: string, code = message, details?: { rootMessage?: string; stderr?: string; exitCode?: string }) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
}));

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

vi.mock('../daemon/src/vad.js', () => ({
  createWasmVad: vi.fn(async () => ({
    isSpeech: () => true,
    destroy: () => {},
  })),
}));

import { ChatError } from '../daemon/src/chatSession.js';
import { buildNewSessionCreateResponse } from '../daemon/src/newSession.js';
import type { NewSessionDestinationOption, RecentSessionsSnapshot, SttCatalog, TtsCatalog, VoiceSettings } from '../daemon/src/protocol.js';
import {
  createVoiceSessionState,
  decidePhoneConnection,
  VoiceSession,
  type SpeechDetectorFactory,
  type TtsSessionFactory,
} from '../daemon/src/voiceSession';

function makeVoiceSession(overrides: {
  sessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
  createSpeechDetector?: SpeechDetectorFactory;
  ttsCatalogProvider?: () => Promise<TtsCatalog>;
  sttCatalogProvider?: () => Promise<SttCatalog>;
  recentSessionsProvider?: () => Promise<RecentSessionsSnapshot>;
  newSessionDiscordDestinationsProvider?: () => Promise<NewSessionDestinationOption[]>;
  newSessionSlackDestinationsProvider?: () => Promise<NewSessionDestinationOption[]>;
  newSessionCreateResponder?: typeof buildNewSessionCreateResponse;
  voiceSettings?: VoiceSettings;
  ttsSessionFactory?: TtsSessionFactory;
  delivery?: { channel: string; target: string; accountId?: string } | null;
  onClose?: (roomId: string) => void;
} = {}) {
  const fakeVad = {
    isSpeech: vi.fn(() => true),
    destroy: vi.fn(),
  };
  const createSpeechDetector = overrides.createSpeechDetector ?? vi.fn(async () => fakeVad);
  const defaultTtsCatalogProvider = vi.fn(async (): Promise<TtsCatalog> => ({
    activeProvider: undefined,
    generatedAt: '2026-04-28T00:00:00.000Z',
    providers: [],
  }));
  const session = new VoiceSession({
    sttLanguage: 'en',
    signalServer: 'https://signal.example',
    iceServers: [],
    hostPeerId: 'host-1',
    roomId: 'host-1:session-1',
    sessionId: 'session-1',
    ...(overrides.sessionKey ? { sessionKey: overrides.sessionKey } : {}),
    ...(overrides.channel ? { channel: overrides.channel } : {}),
    ...(overrides.target ? { target: overrides.target } : {}),
    ...(overrides.accountId ? { accountId: overrides.accountId } : {}),
    ...(overrides.delivery === null
      ? {}
      : { delivery: overrides.delivery ?? { channel: 'discord', target: 'channel:thread-1' } }),
    createSpeechDetector,
    ...(overrides.voiceSettings ? { voiceSettings: overrides.voiceSettings } : {}),
    ttsCatalogProvider: overrides.ttsCatalogProvider ?? defaultTtsCatalogProvider,
    ...(overrides.sttCatalogProvider ? { sttCatalogProvider: overrides.sttCatalogProvider } : {}),
    ...(overrides.recentSessionsProvider ? { recentSessionsProvider: overrides.recentSessionsProvider } : {}),
    ...(overrides.newSessionDiscordDestinationsProvider
      ? { newSessionDiscordDestinationsProvider: overrides.newSessionDiscordDestinationsProvider }
      : {}),
    ...(overrides.newSessionSlackDestinationsProvider
      ? { newSessionSlackDestinationsProvider: overrides.newSessionSlackDestinationsProvider }
      : {}),
    ...(overrides.newSessionCreateResponder ? { newSessionCreateResponder: overrides.newSessionCreateResponder } : {}),
    ...(overrides.ttsSessionFactory ? { ttsSessionFactory: overrides.ttsSessionFactory } : {}),
    onClose: overrides.onClose ?? vi.fn(),
  });
  const peer = {
    destroyed: false,
    send: vi.fn(),
  };
  (session as unknown as { peer: typeof peer; connected: boolean }).peer = peer;
  (session as unknown as { connected: boolean }).connected = true;
  return { session, peer, fakeVad, createSpeechDetector };
}

function sendPeerData(session: VoiceSession, data: unknown): void {
  (session as unknown as { handlePeerData(data: unknown): void }).handlePeerData(data);
}

function sendControl(session: VoiceSession, msg: unknown): void {
  sendPeerData(session, Buffer.from(JSON.stringify(msg)));
}

function sentJson(peer: { send: ReturnType<typeof vi.fn> }): unknown[] {
  return peer.send.mock.calls
    .map(([payload]) => payload)
    .filter((payload): payload is string => typeof payload === 'string')
    .map((payload) => JSON.parse(payload));
}

function sentBinary(peer: { send: ReturnType<typeof vi.fn> }): Buffer[] {
  return peer.send.mock.calls
    .map(([payload]) => payload)
    .filter((payload): payload is Uint8Array => payload instanceof Uint8Array)
    .map((payload) => Buffer.from(payload));
}

function queuedTtsAudio(session: VoiceSession): Buffer[] {
  const turn = (session as unknown as { ttsAudioTurn: { chunks: Buffer[] } | null }).ttsAudioTurn;
  return turn?.chunks.map((chunk) => Buffer.from(chunk)) ?? [];
}

function flattenSnapshotEvents(messages: unknown[]): unknown[] {
  return messages.flatMap((msg) => {
    if (msg && typeof msg === 'object' && 't' in msg && msg.t === 'session.snapshot') {
      return (msg as { events: Array<{ msg: unknown }> }).events.map((event) => event.msg);
    }
    return [msg];
  });
}

function isBufferedTtsStart(msg: unknown): msg is { t: 'tts.start'; buffered: true } {
  return Boolean(
    msg &&
      typeof msg === 'object' &&
      't' in msg &&
      msg.t === 'tts.start' &&
      'buffered' in msg &&
      msg.buffered === true,
  );
}

function bufferedTtsStarts(messages: unknown[]): Array<{ t: 'tts.start'; buffered: true }> {
  return messages.filter(isBufferedTtsStart);
}

function expectNoBufferedTtsStart(messages: unknown[]): void {
  expect(bufferedTtsStarts(messages)).toHaveLength(0);
  expect(bufferedTtsStarts(flattenSnapshotEvents(messages))).toHaveLength(0);
}

describe('voice session state', () => {
  it('binds one room to one session, sessionKey, and delivery target for its lifetime', () => {
    const s = createVoiceSessionState({
      roomId: 'host-1:session-1',
      sessionId: 'session-1',
      sessionKey: 'agent:main:discord:channel:thread-1',
      channel: 'discord',
      target: 'channel:thread-1',
      accountId: 'acct-1',
      delivery: { channel: 'discord', target: 'channel:thread-1' },
    });

    expect(s.chatTarget()).toEqual({
      sessionId: 'session-1',
      sessionKey: 'agent:main:discord:channel:thread-1',
      channel: 'discord',
      target: 'channel:thread-1',
      accountId: 'acct-1',
      delivery: { channel: 'discord', target: 'channel:thread-1' },
    });
    expect(s.roomId).toBe('host-1:session-1');
  });

  it('does not accept route changes on stt.start', () => {
    const s = createVoiceSessionState({
      roomId: 'host-1:session-1',
      sessionId: 'session-1',
      delivery: { channel: 'discord', target: 'channel:thread-1' },
    });

    s.handleStartTurn();

    expect(s.chatTarget().sessionId).toBe('session-1');
    expect(s.chatTarget().delivery.target).toBe('channel:thread-1');
    expect(s.turnInFlight).toBe(true);
  });

  it('marks a voice session closed after cleanup', () => {
    const s = createVoiceSessionState({
      roomId: 'host:s1',
      sessionId: 's1',
      delivery: { channel: 'discord', target: 'channel:t1' },
    });
    expect(s.closed).toBe(false);
    s.close();
    expect(s.closed).toBe(true);
  });

  it('resetTurn clears in-flight flag', () => {
    const s = createVoiceSessionState({
      roomId: 'host:s1',
      sessionId: 's1',
      delivery: { channel: 'discord', target: 'channel:t1' },
    });
    s.handleStartTurn();
    s.resetTurn();
    expect(s.turnInFlight).toBe(false);
  });

  it('uses last-phone-wins decisions for a different incoming phone', () => {
    expect(
      decidePhoneConnection({
        hasCurrentPeer: false,
        currentRemoteId: null,
        incomingRemoteId: 'phone-a',
      }),
    ).toBe('accept');

    expect(
      decidePhoneConnection({
        hasCurrentPeer: true,
        currentRemoteId: 'phone-a',
        incomingRemoteId: 'phone-a',
      }),
    ).toBe('use_existing');

    expect(
      decidePhoneConnection({
        hasCurrentPeer: true,
        currentRemoteId: 'phone-a',
        incomingRemoteId: 'phone-b',
      }),
    ).toBe('replace_existing');
  });


  it('exposes LRU eviction state for idle versus active or in-flight sessions', () => {
    const idleCase = makeVoiceSession();
    (idleCase.session as unknown as { peer: null; connected: boolean }).peer = null;
    (idleCase.session as unknown as { connected: boolean }).connected = false;
    idleCase.session.touchActivity(123);
    expect(idleCase.session.lastUsedAtMs).toBe(123);
    expect(idleCase.session.canEvictForVoiceSessionLimit).toBe(true);

    const activeCase = makeVoiceSession();
    expect(activeCase.session.canEvictForVoiceSessionLimit).toBe(false);

    const inFlightCase = makeVoiceSession();
    (inFlightCase.session as unknown as { peer: null; connected: boolean }).peer = null;
    (inFlightCase.session as unknown as { connected: boolean }).connected = false;
    (inFlightCase.session as unknown as { beginTurn(): number }).beginTurn();
    expect(inFlightCase.session.canEvictForVoiceSessionLimit).toBe(false);
  });
});

describe('voice session capability handshake runtime', () => {
  it('answers client hello before independent catalog messages on the voice lane', async () => {
    const catalog: TtsCatalog = {
      activeProvider: 'openai',
      generatedAt: '2026-04-28T00:00:00.000Z',
      providers: [],
    };
    const ttsCatalogProvider = vi.fn(async () => catalog);
    const { session, peer } = makeVoiceSession({ ttsCatalogProvider });

    sendControl(session, { t: 'client.hello', protocol: 1, wants: ['tts.catalog'] });
    sendControl(session, { t: 'tts.catalog.request' });

    await vi.waitFor(() => {
      expect(sentJson(peer)).toEqual([
        {
          t: 'daemon.hello',
          protocol: 1,
          features: ['tts.catalog', 'stt.catalog', 'sessions.list', 'sessions.catalog', 'sessions.destinations', 'sessions.create'],
        },
        { t: 'tts.catalog', catalog },
      ]);
    });
    expect(ttsCatalogProvider).toHaveBeenCalledTimes(1);
  });

  it('returns one terminal daemon unsupported for protocols outside daemon support bounds without crashing', () => {
    const onClose = vi.fn();
    const { session, peer } = makeVoiceSession({ onClose });

    expect(() => {
      sendControl(session, { t: 'client.hello', protocol: 0, wants: [] });
      sendControl(session, { t: 'client.hello', protocol: 2, wants: [] });
    }).not.toThrow();

    expect(sentJson(peer)).toEqual([
      {
        t: 'daemon.unsupported',
        minProtocol: 1,
        maxProtocol: 1,
        message: 'unsupported_daemon_protocol',
      },
    ]);
    expect(onClose).not.toHaveBeenCalled();
    expect((session as unknown as { state: { closed: boolean } }).state.closed).toBe(false);
  });

  it('treats unsupported protocol as terminal for later voice-lane controls', async () => {
    const catalog: TtsCatalog = {
      activeProvider: 'openai',
      generatedAt: '2026-04-28T00:00:00.000Z',
      providers: [],
    };
    const snapshot: RecentSessionsSnapshot = {
      generatedAt: '2026-04-28T00:00:00.000Z',
      sessions: [],
    };
    const ttsCatalogProvider = vi.fn(async () => catalog);
    const recentSessionsProvider = vi.fn(async () => snapshot);
    const { session, peer } = makeVoiceSession({ ttsCatalogProvider, recentSessionsProvider });

    sendControl(session, { t: 'client.hello', protocol: 2, wants: [] });
    sendControl(session, { t: 'tts.catalog.request' });
    sendControl(session, { t: 'sessions.catalog.request' });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentJson(peer)).toEqual([
      {
        t: 'daemon.unsupported',
        minProtocol: 1,
        maxProtocol: 1,
        message: 'unsupported_daemon_protocol',
      },
    ]);
    expect(ttsCatalogProvider).not.toHaveBeenCalled();
    expect(recentSessionsProvider).not.toHaveBeenCalled();
  });

  it('treats unsupported protocol as terminal for later voice-lane audio', async () => {
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => {
      expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1);
    });
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    sendControl(session, { t: 'client.hello', protocol: 2, wants: [] });
    sendPeerData(session, Buffer.from([1, 2, 3, 4]));
    sendControl(session, { t: 'stt.audio.done' });

    expect(sentJson(peer)).toContainEqual({
      t: 'daemon.unsupported',
      minProtocol: 1,
      maxProtocol: 1,
      message: 'unsupported_daemon_protocol',
    });
    expect(fakeStt.sentAudio).toEqual([]);
    expect(fakeStt.audioDoneCalls).toBe(0);
  });

  it('drops already-started async voice turn callbacks after daemon unsupported', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => {
      expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1);
    });
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    sendControl(session, { t: 'client.hello', protocol: 2, wants: [] });
    fakeStt.cb.onReady();
    fakeStt.cb.onDone('hello after unsupported');
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (ttsMocks.inferTtsCtor.mock.results[0]) {
      const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;
      fakeTts.cb.onOpen();
      fakeTts.cb.onAudio(new Uint8Array([1, 2, 3, 4]));
      fakeTts.cb.onDone();
    }

    expect(sentJson(peer)).toEqual([
      {
        t: 'daemon.unsupported',
        minProtocol: 1,
        maxProtocol: 1,
        message: 'unsupported_daemon_protocol',
      },
    ]);
    expect(sentBinary(peer)).toEqual([]);
    expect(chatMocks.runChat).not.toHaveBeenCalled();
    expect(ttsMocks.inferTtsCtor).not.toHaveBeenCalled();

    const reconnectPeer = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);
    const snapshot = sentJson(reconnectPeer)[0] as { t: string; events: Array<{ msg: { t: string } }> };
    expect(snapshot.t).toBe('session.snapshot');
    expect(snapshot.events).toEqual([]);
  });

  it('does not answer repeated client hello after voice protocol is unsupported', async () => {
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'client.hello', protocol: 2, wants: [] });
    sendControl(session, { t: 'client.hello', protocol: 1, wants: ['tts.catalog'] });
    sendControl(session, { t: 'tts.catalog.request' });

    expect(sentJson(peer)).toEqual([
      {
        t: 'daemon.unsupported',
        minProtocol: 1,
        maxProtocol: 1,
        message: 'unsupported_daemon_protocol',
      },
    ]);
  });

  it('clears unsupported protocol state when a replacement peer takes over the voice room', async () => {
    const catalog: TtsCatalog = {
      activeProvider: 'openai',
      generatedAt: '2026-04-28T00:00:00.000Z',
      providers: [],
    };
    const ttsCatalogProvider = vi.fn(async () => catalog);
    const { session, peer } = makeVoiceSession({ ttsCatalogProvider });

    sendControl(session, { t: 'client.hello', protocol: 2, wants: [] });
    sendControl(session, { t: 'tts.catalog.request' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentJson(peer)).toEqual([
      {
        t: 'daemon.unsupported',
        minProtocol: 1,
        maxProtocol: 1,
        message: 'unsupported_daemon_protocol',
      },
    ]);
    expect(ttsCatalogProvider).not.toHaveBeenCalled();

    const replacementPeer = {
      destroyed: false,
      send: vi.fn(),
    };
    (session as unknown as { tearDownPeer(reason: string): void }).tearDownPeer('peer_closed');
    (session as unknown as { peer: typeof replacementPeer; connected: boolean }).peer = replacementPeer;
    (session as unknown as { connected: boolean }).connected = true;

    sendControl(session, { t: 'client.hello', protocol: 1, wants: ['tts.catalog'] });
    sendControl(session, { t: 'tts.catalog.request' });

    await vi.waitFor(() => {
      expect(sentJson(replacementPeer)).toEqual([
        {
          t: 'daemon.hello',
          protocol: 1,
          features: ['tts.catalog', 'stt.catalog', 'sessions.list', 'sessions.catalog', 'sessions.destinations', 'sessions.create'],
        },
        { t: 'tts.catalog', catalog },
      ]);
    });
    expect(ttsCatalogProvider).toHaveBeenCalledTimes(1);
  });

  it('does not replay voice-lane handshake responses in later catch-up snapshots', async () => {
    const catalog: TtsCatalog = {
      activeProvider: 'openai',
      generatedAt: '2026-04-28T00:00:00.000Z',
      providers: [],
    };

    const { session, peer } = makeVoiceSession({ ttsCatalogProvider: vi.fn(async () => catalog) });

    sendControl(session, { t: 'client.hello', protocol: 1, wants: ['tts.catalog'] });
    sendControl(session, { t: 'tts.catalog.request' });

    await vi.waitFor(() => {
      expect(sentJson(peer)).toContainEqual({ t: 'tts.catalog', catalog });
    });

    const reconnectPeer = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);
    const snapshot = sentJson(reconnectPeer)[0] as {
      t: string;
      events: Array<{ msg: { t: string } }>;
    };

    expect(snapshot.t).toBe('session.snapshot');
    expect(snapshot.events.map((event) => event.msg.t)).toEqual(['tts.catalog']);
  });
});

describe('voice session TTS catalog runtime', () => {
  beforeEach(() => {
    chatMocks.runChat.mockReset();
  });

  it('sends the TTS catalog when the phone requests it', async () => {
    const catalog: TtsCatalog = {
      activeProvider: 'openai',
      generatedAt: '2026-04-28T00:00:00.000Z',
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          configured: true,
          selected: true,
          available: true,
          models: ['gpt-4o-mini-tts'],
          voices: [{ id: 'nova', name: 'Nova' }],
        },
      ],
    };
    const ttsCatalogProvider = vi.fn(async () => catalog);
    const { session, peer } = makeVoiceSession({ ttsCatalogProvider });

    sendControl(session, { t: 'tts.catalog.request' });

    await vi.waitFor(() => {
      expect(sentJson(peer)).toContainEqual({ t: 'tts.catalog', catalog });
    });
    expect(ttsCatalogProvider).toHaveBeenCalledTimes(1);
  });

  it('sends an empty TTS catalog when the catalog load fails without closing the session', async () => {
    const onClose = vi.fn();
    const ttsCatalogProvider = vi.fn(async () => {
      throw new Error('catalog failed');
    });
    const { session, peer } = makeVoiceSession({ ttsCatalogProvider, onClose });

    sendControl(session, { t: 'tts.catalog.request' });

    await vi.waitFor(() => {
      expect(sentJson(peer)).toContainEqual({
        t: 'tts.catalog',
        catalog: {
          activeProvider: undefined,
          generatedAt: expect.any(String),
          providers: [],
        },
      });
    });
    expect(onClose).not.toHaveBeenCalled();
    expect((session as unknown as { state: { closed: boolean } }).state.closed).toBe(false);
  });
});


describe('voice session recent-session list runtime', () => {
  it('sends the recent session list when the phone requests it', async () => {
    const snapshot: RecentSessionsSnapshot = {
      generatedAt: '2026-05-05T19:00:00.000Z',
      sessions: [
        {
          sessionId: 'session-uuid',
          sessionKey: 'agent:kamaji:discord:channel:t1',
          agent: 'kamaji',
          channel: 'discord',
          target: 'channel:t1',
          lastActivity: '2026-05-05T18:59:00.000Z',
          displayLabel: 'planning',
        },
      ],
    };
    const recentSessionsProvider = vi.fn(async () => snapshot);
    const { session, peer } = makeVoiceSession({ recentSessionsProvider });

    sendControl(session, { t: 'sessions.list.request' });

    await vi.waitFor(() => {
      expect(sentJson(peer)).toContainEqual({
        t: 'sessions.list',
        generatedAt: snapshot.generatedAt,
        sessions: snapshot.sessions,
      });
    });
    expect(recentSessionsProvider).toHaveBeenCalledTimes(1);
  });


  it('answers legacy recent-session catalog requests with the catalog payload shape', async () => {
    const snapshot: RecentSessionsSnapshot = { generatedAt: 'catalog-time', sessions: [] };
    const recentSessionsProvider = vi.fn(async () => snapshot);
    const { session, peer } = makeVoiceSession({ recentSessionsProvider });

    sendControl(session, { t: 'sessions.catalog.request' });

    await vi.waitFor(() => {
      expect(sentJson(peer)).toContainEqual({ t: 'sessions.catalog', catalog: snapshot });
    });
  });

  it('answers new-session destination requests on the voice lane from the real channel catalogs', async () => {
    const snapshot: RecentSessionsSnapshot = {
      generatedAt: 'destinations-time',
      sessions: [
        {
          sessionId: 'uuid-1',
          sessionKey: 'agent:main:discord:channel:thread-1',
          agent: 'main',
          channel: 'discord',
          target: 'channel:thread-1',
          displayLabel: 'Thread one',
        },
      ],
    };
    const recentSessionsProvider = vi.fn(async () => snapshot);
    const newSessionDiscordDestinationsProvider = vi.fn(async (): Promise<NewSessionDestinationOption[]> => [
      { id: 'discord:channel:100', target: 'channel:100', label: '#general' },
    ]);
    const newSessionSlackDestinationsProvider = vi.fn(async (): Promise<NewSessionDestinationOption[]> => [
      { id: 'slack:channel:C123', target: 'channel:C123', label: '#general' },
    ]);
    const { session, peer } = makeVoiceSession({
      recentSessionsProvider,
      newSessionDiscordDestinationsProvider,
      newSessionSlackDestinationsProvider,
    });

    sendControl(session, { t: 'sessions.destinations.request' });

    await vi.waitFor(() => {
      const destinations = sentJson(peer).find((msg) =>
        (msg as { t: string }).t === 'sessions.destinations' &&
        (msg as { catalog?: { providers?: { id: string }[] } }).catalog?.providers?.some((provider) => provider.id === 'discord')
      ) as
        | { catalog: { providers: { id: string; status: string; destinations: { target: string }[] }[] } }
        | undefined;
      expect(destinations).toBeTruthy();
      expect(destinations!.catalog.providers.map((provider) => provider.id)).toEqual(['webchat', 'discord', 'slack']);
      expect(destinations!.catalog.providers.every((provider) => provider.status === 'available')).toBe(true);
      // Real catalog channels only — the recent-session thread target stays out.
      expect(destinations!.catalog.providers[1].destinations.map((d) => d.target)).toEqual(['channel:100']);
      expect(destinations!.catalog.providers[2].destinations.map((d) => d.target)).toEqual(['channel:C123']);
    });
    expect(newSessionDiscordDestinationsProvider).toHaveBeenCalledTimes(1);
    expect(newSessionSlackDestinationsProvider).toHaveBeenCalledTimes(1);
  });

  it('omits channel providers on the voice lane when no real channel catalog exists', async () => {
    const { session, peer } = makeVoiceSession({
      recentSessionsProvider: vi.fn(async () => ({ generatedAt: 't', sessions: [] })),
      newSessionDiscordDestinationsProvider: vi.fn(async (): Promise<NewSessionDestinationOption[]> => []),
      newSessionSlackDestinationsProvider: vi.fn(async (): Promise<NewSessionDestinationOption[]> => []),
    });

    sendControl(session, { t: 'sessions.destinations.request' });

    await vi.waitFor(() => {
      const destinations = sentJson(peer).find((msg) => (msg as { t: string }).t === 'sessions.destinations') as
        | { catalog: { providers: { id: string }[] } }
        | undefined;
      expect(destinations).toBeTruthy();
      expect(destinations!.catalog.providers.map((provider) => provider.id)).toEqual(['webchat']);
    });
  });

  it('answers new-session create requests on the voice lane', async () => {
    const execOpenClaw = vi.fn(async (_command: string, args: string[]) =>
      args.includes('thread')
        ? { stdout: '{"thread":{"id":"t-777"}}' }
        : { stdout: '{"ts":"1710000000.000100"}' });
    const { session, peer } = makeVoiceSession({
      recentSessionsProvider: vi.fn(async () => ({ generatedAt: 't', sessions: [] })),
      newSessionCreateResponder: (msg) => buildNewSessionCreateResponse(msg, { execOpenClaw }),
    });

    sendControl(session, { t: 'sessions.create.request', requestId: 'req-1', providerId: 'webchat' });

    await vi.waitFor(() => {
      const created = sentJson(peer).find((msg) => (msg as { t: string }).t === 'sessions.created') as
        | { requestId: string; session: { sessionId: string; channel?: string } }
        | undefined;
      expect(created).toBeTruthy();
      expect(created!.requestId).toBe('req-1');
      expect(created!.session.channel).toBe('webchat');
      expect(created!.session.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    });

    sendControl(session, {
      t: 'sessions.create.request',
      requestId: 'req-2',
      providerId: 'discord',
      target: 'channel:parent-1',
      accountId: 'acct-a',
    });

    await vi.waitFor(() => {
      const discordCreated = sentJson(peer).find(
        (msg) => (msg as { t: string; requestId?: string }).t === 'sessions.created'
          && (msg as { requestId?: string }).requestId === 'req-2',
      ) as { session: { sessionKey: string; channel?: string; target?: string; accountId?: string } } | undefined;
      expect(discordCreated).toBeTruthy();
      expect(discordCreated!.session.channel).toBe('discord');
      expect(discordCreated!.session.target).toBe('channel:t-777');
      expect(discordCreated!.session.sessionKey).toBe('agent:main:discord:channel:t-777');
      expect(discordCreated!.session.accountId).toBe('acct-a');
    });
    expect(execOpenClaw).toHaveBeenCalledTimes(1);

    sendControl(session, {
      t: 'sessions.create.request',
      requestId: 'req-3',
      providerId: 'slack',
      target: 'channel:C123',
    });

    await vi.waitFor(() => {
      const slackCreated = sentJson(peer).find(
        (msg) => (msg as { t: string; requestId?: string }).t === 'sessions.created'
          && (msg as { requestId?: string }).requestId === 'req-3',
      ) as { session: { sessionKey: string; channel?: string; target?: string } } | undefined;
      expect(slackCreated).toBeTruthy();
      expect(slackCreated!.session.channel).toBe('slack');
      expect(slackCreated!.session.target).toBe('channel:C123');
      expect(slackCreated!.session.sessionKey).toBe('agent:main:slack:channel:C123:thread:1710000000.000100');
    });
    expect(execOpenClaw).toHaveBeenCalledTimes(2);

    sendControl(session, { t: 'sessions.create.request', requestId: 'req-4', providerId: 'telegram', target: 'chat:1' });

    await vi.waitFor(() => {
      expect(sentJson(peer)).toContainEqual({
        t: 'sessions.create.error',
        requestId: 'req-4',
        message: 'new_session_destination_unsupported',
      });
    });
  });

  it('subscribes to recent session list updates without closing the session on provider failure', async () => {
    vi.useFakeTimers();
    const first: RecentSessionsSnapshot = { generatedAt: 'first', sessions: [] };
    const recentSessionsProvider = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('sessions failed'));
    const onClose = vi.fn();
    const { session, peer } = makeVoiceSession({ recentSessionsProvider, onClose });

    sendControl(session, { t: 'sessions.list.subscribe' });

    await vi.waitFor(() => {
      expect(sentJson(peer)).toContainEqual({ t: 'sessions.list', generatedAt: 'first', sessions: [] });
    });
    await vi.advanceTimersByTimeAsync(60_000);

    await vi.waitFor(() => {
      expect(sentJson(peer).filter((msg) => msg.t === 'sessions.list')).toHaveLength(2);
    });
    expect(onClose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('voice session STT catalog runtime', () => {
  beforeEach(() => {
    chatMocks.runChat.mockReset();
  });

  it('sends the STT catalog when the phone requests it', async () => {
    const catalog: SttCatalog = {
      activeProvider: 'xai',
      generatedAt: '2026-04-29T00:00:00.000Z',
      providers: [
        {
          id: 'xai',
          name: 'xai',
          configured: true,
          selected: true,
          available: true,
          models: ['grok-stt'],
        },
      ],
    };
    const sttCatalogProvider = vi.fn(async () => catalog);
    const { session, peer } = makeVoiceSession({ sttCatalogProvider });

    sendControl(session, { t: 'stt.catalog.request' });

    await vi.waitFor(() => {
      expect(sentJson(peer)).toContainEqual({ t: 'stt.catalog', catalog });
    });
    expect(sttCatalogProvider).toHaveBeenCalledTimes(1);
  });

  it('sends an empty STT catalog when the catalog load fails without closing the session', async () => {
    const onClose = vi.fn();
    const sttCatalogProvider = vi.fn(async () => {
      throw new Error('catalog failed');
    });
    const { session, peer } = makeVoiceSession({ sttCatalogProvider, onClose });

    sendControl(session, { t: 'stt.catalog.request' });

    await vi.waitFor(() => {
      expect(sentJson(peer)).toContainEqual({
        t: 'stt.catalog',
        catalog: {
          activeProvider: undefined,
          generatedAt: expect.any(String),
          providers: [],
        },
      });
    });
    expect(onClose).not.toHaveBeenCalled();
    expect((session as unknown as { state: { closed: boolean } }).state.closed).toBe(false);
  });

  it('does not respond to stt.catalog.request from the TTS catalog provider', async () => {
    const ttsCatalogProvider = vi.fn(async () => ({
      activeProvider: 'openai',
      generatedAt: '2026-04-29T00:00:00.000Z',
      providers: [],
    }));
    const sttCatalogProvider = vi.fn(async () => ({
      activeProvider: 'xai',
      generatedAt: '2026-04-29T00:00:00.000Z',
      providers: [],
    }));
    const { session } = makeVoiceSession({ ttsCatalogProvider, sttCatalogProvider });

    sendControl(session, { t: 'stt.catalog.request' });

    await vi.waitFor(() => {
      expect(sttCatalogProvider).toHaveBeenCalledTimes(1);
    });
    expect(ttsCatalogProvider).not.toHaveBeenCalled();
  });
});

describe('voice session OpenClaw infer STT runtime', () => {
  beforeEach(() => {
    sttMocks.inferCtor.mockClear();
    ttsMocks.inferTtsCtor.mockClear();
    chatMocks.runChat.mockReset();
    chatMocks.runChat.mockReturnValue(new Promise(() => {}));
  });

  it('passes the selected STT provider/model into OpenClawInferSttSession when both are set', async () => {
    const { session } = makeVoiceSession();

    sendControl(session, {
      t: 'settings.update',
      settings: { stt: { providerId: 'xai', model: 'grok-stt' } },
    });
    sendControl(session, { t: 'stt.start' });

    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    expect(sttMocks.inferCtor.mock.calls[0][0]).toMatchObject({
      language: 'en',
      model: 'xai/grok-stt',
    });
  });

  it('omits the STT model when only one of provider or model is set', async () => {
    const { session } = makeVoiceSession();

    sendControl(session, {
      t: 'settings.update',
      settings: { stt: { providerId: 'xai' } },
    });
    sendControl(session, { t: 'stt.start' });

    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    expect(sttMocks.inferCtor.mock.calls[0][0]).not.toHaveProperty('model');
  });

  it('omits the STT model after Default clears a prior explicit selection', async () => {
    const { session } = makeVoiceSession();

    sendControl(session, {
      t: 'settings.update',
      settings: { stt: { providerId: 'xai', model: 'grok-stt' } },
    });
    sendControl(session, { t: 'settings.update', settings: {} });
    sendControl(session, { t: 'stt.start' });

    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    expect(sttMocks.inferCtor.mock.calls[0][0]).not.toHaveProperty('model');
  });

  it('reads initial STT selection from voiceSettings on construction', async () => {
    const session = new VoiceSession({
      sttLanguage: 'en',
      signalServer: 'https://signal.example',
      iceServers: [],
      hostPeerId: 'host-1',
      roomId: 'host-1:session-1',
      sessionId: 'session-1',
      delivery: { channel: 'discord', target: 'channel:thread-1' },
      voiceSettings: { stt: { providerId: 'openai', model: 'whisper-1' } },
      createSpeechDetector: vi.fn(async () => ({ isSpeech: () => true, destroy: () => {} })),
      onClose: vi.fn(),
    });
    const peer = { destroyed: false, send: vi.fn() };
    (session as unknown as { peer: typeof peer; connected: boolean }).peer = peer;
    (session as unknown as { connected: boolean }).connected = true;

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    expect(sttMocks.inferCtor.mock.calls[0][0]).toMatchObject({ model: 'openai/whisper-1' });
  });

  it('changing only the TTS selection does not introduce an STT model override', async () => {
    const { session } = makeVoiceSession();

    sendControl(session, {
      t: 'settings.update',
      settings: { tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' } },
    });
    sendControl(session, { t: 'stt.start' });

    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    expect(sttMocks.inferCtor.mock.calls[0][0]).not.toHaveProperty('model');
  });

  it('opens OpenClaw infer STT with phrase chunking and WASM VAD on stt.start', async () => {
    const { session, fakeVad, createSpeechDetector } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });

    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    expect(createSpeechDetector).toHaveBeenCalledWith({ sampleRate: 16000 });
    expect(sttMocks.inferCtor.mock.calls[0][0]).toMatchObject({
      language: 'en',
      sampleRate: 16000,
      enablePhraseChunks: true,
      speechDetector: fakeVad,
    });
  });

  it('opens final-turn STT without phrase chunks when WASM VAD init fails', async () => {
    const createSpeechDetector = vi.fn(async () => {
      throw new Error('vad unavailable');
    });
    const { session, peer } = makeVoiceSession({ createSpeechDetector });
    const pcm = Buffer.from([1, 2, 3, 4]);

    sendControl(session, { t: 'stt.start' });

    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    expect(createSpeechDetector).toHaveBeenCalledWith({ sampleRate: 16000 });
    expect(sttMocks.inferCtor.mock.calls[0][0]).toMatchObject({
      language: 'en',
      sampleRate: 16000,
      enablePhraseChunks: false,
    });
    expect(sttMocks.inferCtor.mock.calls[0][0]).not.toHaveProperty('speechDetector');

    const fakeStt = sttMocks.inferCtor.mock.results[0].value;
    fakeStt.cb.onReady();
    sendPeerData(session, pcm);
    sendControl(session, { t: 'stt.audio.done' });

    expect(fakeStt.sendAudio).toHaveBeenCalledTimes(1);
    expect(Buffer.from(fakeStt.sentAudio[0])).toEqual(pcm);
    expect(fakeStt.signalAudioDone).toHaveBeenCalledTimes(1);
    expect(sentJson(peer)).toEqual([{ t: 'stt.ready' }]);
    expect((session as unknown as { state: { turnInFlight: boolean } }).state.turnInFlight).toBe(true);
  });

  it('forwards binary PCM frames to the OpenClaw infer STT session', async () => {
    const { session } = makeVoiceSession();
    const pcm = Buffer.from([1, 2, 3, 4]);

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    sendPeerData(session, pcm);

    expect(fakeStt.sendAudio).toHaveBeenCalledTimes(1);
    expect(Buffer.from(fakeStt.sentAudio[0])).toEqual(pcm);
  });

  it('signals audio done on stt.audio.done', async () => {
    const { session } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    sendControl(session, { t: 'stt.audio.done' });

    expect(fakeStt.signalAudioDone).toHaveBeenCalledTimes(1);
  });

  it('sends stt.done, then starts the reply turn when STT finishes', async () => {
    const { session, peer } = makeVoiceSession({
      sessionKey: 'agent:main:discord:channel:thread-1',
      channel: 'discord',
      target: 'channel:thread-1',
      accountId: 'acct-1',
    });

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    fakeStt.cb.onDone('hello');

    expect(sentJson(peer)).toEqual([
      { t: 'stt.done', text: 'hello' },
      { t: 'reply.start', text: 'hello' },
    ]);
    expect(chatMocks.runChat).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({
        sessionId: 'session-1',
        sessionKey: 'agent:main:discord:channel:thread-1',
        channel: 'discord',
        target: 'channel:thread-1',
        accountId: 'acct-1',
        delivery: { channel: 'discord', target: 'channel:thread-1' },
        deliver: true,
      }),
    );
  });

  it('keeps the selected Kamaji session key and originating reply target on voice chat turns', async () => {
    const { session } = makeVoiceSession({
      sessionKey: 'agent:kamaji:discord:channel:1501983803436961932',
      channel: 'discord',
      target: 'channel:1501983803436961932',
      delivery: null,
    });

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    fakeStt.cb.onDone('hello kamaji');

    expect(chatMocks.runChat).toHaveBeenCalledWith(
      'hello kamaji',
      expect.objectContaining({
        sessionId: 'session-1',
        sessionKey: 'agent:kamaji:discord:channel:1501983803436961932',
        channel: 'discord',
        target: 'channel:1501983803436961932',
        deliver: true,
      }),
    );
  });

  it('runs webchat/no-chat voice turns without mandatory reply delivery', async () => {
    const { session } = makeVoiceSession({
      sessionKey: 'agent:main:webchat:session:session-1',
      channel: 'webchat',
      delivery: null,
    });

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    fakeStt.cb.onDone('hello web');

    expect(chatMocks.runChat).toHaveBeenCalledWith(
      'hello web',
      expect.objectContaining({
        sessionId: 'session-1',
        sessionKey: 'agent:main:webchat:session:session-1',
        channel: 'webchat',
        deliver: false,
      }),
    );
  });

  it('routes empty final STT text through the empty_transcript reply path', async () => {
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    fakeStt.cb.onDone('   ');

    expect(sentJson(peer)).toEqual([
      { t: 'stt.done', text: '   ' },
      { t: 'reply.error', message: 'empty_transcript' },
    ]);
    expect(chatMocks.runChat).not.toHaveBeenCalled();
    expect((session as unknown as { state: { turnInFlight: boolean } }).state.turnInFlight).toBe(false);
  });

  it('forwards near-live final partial chunks to the phone before final STT completion', async () => {
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    fakeStt.cb.onPartial('chunk words', true);
    fakeStt.cb.onDone('authoritative final');

    expect(sentJson(peer)).toEqual([
      { t: 'stt.partial', text: 'chunk words', is_final: true },
      { t: 'stt.done', text: 'authoritative final' },
      { t: 'reply.start', text: 'authoritative final' },
    ]);
    expect(chatMocks.runChat).toHaveBeenCalledWith(
      'authoritative final',
      expect.objectContaining({ deliver: true }),
    );
    expect(chatMocks.runChat).not.toHaveBeenCalledWith('chunk words', expect.anything());
  });



  it('accepts malformed settings.update payloads without throwing or storing non-string fields', () => {
    const { session } = makeVoiceSession();

    expect(() => {
      sendControl(session, {
        t: 'settings.update',
        settings: { tts: { providerId: 123, model: ['bad'], voice: 456 }, voice: ' rex ' },
      });
    }).not.toThrow();

    expect((session as unknown as { currentTtsSelection: unknown }).currentTtsSelection).toEqual({
      voice: 'rex',
    });
  });

  it('does not let stale TTS catalog resolution open audio after the turn is canceled and restarted', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    let resolveCatalog: ((catalog: TtsCatalog) => void) | undefined;
    const ttsCatalogProvider = vi.fn(() => new Promise<TtsCatalog>((resolve) => { resolveCatalog = resolve; }));
    const { session } = makeVoiceSession({ ttsCatalogProvider });
    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const firstStt = sttMocks.inferCtor.mock.results[0].value;
    firstStt.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsCatalogProvider).toHaveBeenCalledTimes(1));
    sendControl(session, { t: 'reply.cancel' });
    sendControl(session, { t: 'stt.start' });
    resolveCatalog?.({ activeProvider: undefined, generatedAt: '2026-04-28T00:00:00.000Z', providers: [] });
    await Promise.resolve();
    expect(ttsMocks.inferTtsCtor).not.toHaveBeenCalled();
  });

  it('times out slow TTS catalog loading and falls back to normal TTS creation', async () => {
    vi.useFakeTimers();
    try {
      chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
      const ttsCatalogProvider = vi.fn(() => new Promise<TtsCatalog>(() => {}));
      const { session } = makeVoiceSession({ ttsCatalogProvider, voiceSettings: { tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' } } });
      sendControl(session, { t: 'stt.start' });
      await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
      sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
      await vi.waitFor(() => expect(ttsCatalogProvider).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1500);
      await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
      expect(ttsMocks.inferTtsCtor.mock.results[0].value.opts).toEqual({ text: 'spoken reply', voice: 'nova', model: 'openai/gpt-4o-mini-tts' });
    } finally { vi.useRealTimers(); }
  });

  it('redacts provider secrets from TTS catalog and factory failure logs', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
      const ttsCatalogProvider = vi.fn(async () => { throw Object.assign(new Error('catalog failed openai_api_key=secret'), { stderr: 'authorization: bearer token OPENAI_API_KEY=other-secret' }); });
      const ttsSessionFactory = vi.fn(() => { throw Object.assign(new Error('factory failed xai_api_key=secret'), { stderr: 'authorization: bearer token-secret' }); });
      const { session, peer } = makeVoiceSession({ ttsCatalogProvider, ttsSessionFactory });
      sendControl(session, { t: 'stt.start' });
      await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
      sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
      await vi.waitFor(() => expect(sentJson(peer)).toContainEqual({ t: 'tts.error', message: 'openclaw_infer_tts_failed' }));
      const logs = consoleError.mock.calls.map(([msg]) => String(msg)).join('\n');
      expect(logs).toContain('openai_api_key=[redacted]');
      expect(logs).toContain('OPENAI_API_KEY=[redacted]');
      expect(logs).toContain('xai_api_key=[redacted]');
      expect(logs).not.toContain('other-secret');
      expect(logs).not.toContain('token-secret');
    } finally { consoleError.mockRestore(); }
  });

  it('uses OpenClaw infer TTS for the reply, emits tts.start/audio/tts.done, and resets the turn', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session, peer } = makeVoiceSession();

    sendControl(session, {
      t: 'settings.update',
      settings: { tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' } },
    });
    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    fakeStt.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    expect(fakeTts.opts).toEqual({
      text: 'spoken reply',
      voice: 'nova',
      model: 'openai/gpt-4o-mini-tts',
    });

    fakeTts.cb.onOpen();
    fakeTts.cb.onAudio(new Uint8Array([1, 2, 3, 4]));
    fakeTts.cb.onDone();

    expect(sentJson(peer)).toEqual([
      { t: 'stt.done', text: 'hello' },
      { t: 'reply.start', text: 'hello' },
      { t: 'reply.done', text: 'spoken reply' },
      { t: 'tts.start', sample_rate: 24000 },
      { t: 'tts.done' },
    ]);
    expect(sentBinary(peer)).toEqual([Buffer.from([1, 2, 3, 4])]);
    expect((session as unknown as { state: { turnInFlight: boolean } }).state.turnInFlight).toBe(false);
  });

  it('appends each generated TTS chunk exactly once to the canonical queue across track, disconnected, and data-channel paths', async () => {
    async function startTts(session: VoiceSession, expectedCall: number) {
      sendControl(session, { t: 'stt.start' });
      await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(expectedCall));
      sttMocks.inferCtor.mock.results[expectedCall - 1].value.cb.onDone('hello');
      await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(expectedCall));
      const fakeTts = ttsMocks.inferTtsCtor.mock.results[expectedCall - 1].value;
      fakeTts.cb.onOpen();
      return fakeTts;
    }

    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });

    const trackCase = makeVoiceSession();
    (trackCase.session as unknown as { audioSource: { onData: ReturnType<typeof vi.fn> }; outboundStream: unknown }).audioSource = { onData: vi.fn() };
    (trackCase.session as unknown as { outboundStream: unknown }).outboundStream = { active: true };
    const trackTts = await startTts(trackCase.session, 1);
    trackTts.cb.onAudio(new Uint8Array([1, 1]));
    trackTts.cb.onAudio(new Uint8Array([2, 2]));
    expect(queuedTtsAudio(trackCase.session)).toEqual([Buffer.from([1, 1]), Buffer.from([2, 2])]);

    const disconnectedCase = makeVoiceSession();
    const disconnectedTts = await startTts(disconnectedCase.session, 2);
    (disconnectedCase.session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', disconnectedCase.peer);
    disconnectedTts.cb.onAudio(new Uint8Array([3, 3]));
    disconnectedTts.cb.onAudio(new Uint8Array([4, 4]));
    expect(queuedTtsAudio(disconnectedCase.session)).toEqual([Buffer.from([3, 3]), Buffer.from([4, 4])]);

    const dataChannelCase = makeVoiceSession();
    const dataChannelTts = await startTts(dataChannelCase.session, 3);
    dataChannelTts.cb.onAudio(new Uint8Array([5, 5]));
    dataChannelTts.cb.onAudio(new Uint8Array([6, 6]));
    expect(sentBinary(dataChannelCase.peer)).toEqual([Buffer.from([5, 5]), Buffer.from([6, 6])]);
    expect(queuedTtsAudio(dataChannelCase.session)).toEqual([Buffer.from([5, 5]), Buffer.from([6, 6])]);
  });

  it('drops replay retention only after TTS overflow while live data-channel audio keeps playing', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    fakeTts.cb.onOpen();
    const runtime = session as unknown as {
      ttsAudioTurn: {
        chunks: Buffer[];
        byteLength: number;
        overflowed: boolean;
        replayOnReconnect: boolean;
      } | null;
      tearDownPeer(reason: string, peer?: unknown): void;
      sendCatchUpSnapshot(peer: unknown): void;
    };
    const turn = runtime.ttsAudioTurn;
    expect(turn).not.toBeNull();
    turn!.byteLength = 64 * 1024 * 1024 - 1;

    fakeTts.cb.onAudio(new Uint8Array([7, 7]));
    fakeTts.cb.onAudio(new Uint8Array([8, 8]));

    expect(sentBinary(peer)).toEqual([Buffer.from([7, 7]), Buffer.from([8, 8])]);
    expect(turn!.overflowed).toBe(true);
    expect(turn!.chunks).toEqual([]);
    expect(turn!.byteLength).toBe(0);
    expect(turn!.replayOnReconnect).toBe(false);

    runtime.tearDownPeer('peer_closed', peer);
    fakeTts.cb.onDone();

    const reconnectPeer = { send: vi.fn() };
    runtime.sendCatchUpSnapshot(reconnectPeer);
    const reconnectJson = sentJson(reconnectPeer) as Array<{ t: string; buffered?: boolean }>;
    expectNoBufferedTtsStart(reconnectJson);
    expect(sentBinary(reconnectPeer)).toEqual([]);
    expect(runtime.ttsAudioTurn).toBeNull();
  });

  it('does not replay data-channel TTS that had already started before peer detach', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    fakeTts.cb.onOpen();
    fakeTts.cb.onAudio(new Uint8Array([1, 0]));
    fakeTts.cb.onAudio(new Uint8Array([2, 0]));
    expect(sentJson(peer)).toContainEqual({ t: 'tts.start', sample_rate: 24000 });
    expect(sentBinary(peer)).toEqual([Buffer.from([1, 0]), Buffer.from([2, 0])]);

    (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);
    fakeTts.cb.onDone();

    const reconnectPeer = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);

    const json = sentJson(reconnectPeer);
    expect(json[0]).toMatchObject({
      t: 'session.snapshot',
      turn: expect.objectContaining({ inFlight: false, phase: 'complete', replyText: 'spoken reply' }),
    });
    expect(flattenSnapshotEvents(json)).toContainEqual({ t: 'tts.done' });
    expectNoBufferedTtsStart(json);
    expect(sentBinary(reconnectPeer)).toEqual([]);
    expect((session as unknown as { ttsAudioTurn: unknown | null }).ttsAudioTurn).toBeNull();
  });

  it('does not forward legacy voice-only settings to TTS without a canonical model', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session } = makeVoiceSession();

    sendControl(session, { t: 'settings.update', settings: { voice: 'eve' } });
    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    fakeStt.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    expect(fakeTts.opts).toEqual({
      text: 'spoken reply',
    });
  });

  it('does not forward rex legacy voice-only settings to TTS without a canonical model', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session } = makeVoiceSession();

    sendControl(session, { t: 'settings.update', settings: { voice: 'rex' } });
    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    fakeStt.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    expect(fakeTts.opts).toEqual({
      text: 'spoken reply',
    });
  });

  it('omits TTS model and voice after Default clears a prior explicit selection', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session } = makeVoiceSession();

    sendControl(session, {
      t: 'settings.update',
      settings: { tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' } },
    });
    sendControl(session, { t: 'settings.update', settings: {} });
    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    fakeStt.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    expect(fakeTts.opts).toEqual({
      text: 'spoken reply',
    });
  });

  it('forwards canonical provider-specific TTS voice settings with the selected model', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session } = makeVoiceSession();

    sendControl(session, {
      t: 'settings.update',
      settings: { tts: { providerId: 'xai', model: 'grok-voice', voice: 'eve' } },
    });
    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    fakeStt.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    expect(fakeTts.opts).toEqual({
      text: 'spoken reply',
      voice: 'eve',
      model: 'xai/grok-voice',
    });
  });

  it('logs OpenClaw reply failures with context, code, and sanitized cause details', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    chatMocks.runChat.mockRejectedValue(
      new ChatError(
        'Command failed: openclaw "agent" "--message" "secret transcript"',
        'openclaw_gateway_unavailable',
        {
          rootMessage: 'Command failed: openclaw "agent" "--message" "[redacted]"',
          stderr: 'connect ECONNREFUSED 127.0.0.1:18789',
          exitCode: '1',
        },
      ),
    );
    const { session, peer } = makeVoiceSession();

    try {
      sendControl(session, { t: 'stt.start' });
      await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
      const fakeStt = sttMocks.inferCtor.mock.results[0].value;

      fakeStt.cb.onDone('hello');
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('reply failed')));

      const logLine = String(consoleError.mock.calls.find(([msg]) => String(msg).includes('reply failed'))?.[0]);
      expect(logLine).toContain('[voice host-1:session-1] reply failed');
      expect(logLine).toContain('session=session-1');
      expect(logLine).toContain('delivery=discord:channel:thread-1');
      expect(logLine).toContain('code=openclaw_gateway_unavailable');
      expect(logLine).toContain('stderr=connect ECONNREFUSED 127.0.0.1:18789');
      expect(logLine).not.toContain('secret transcript');
      expect(sentJson(peer)).toContainEqual({ t: 'reply.error', message: 'openclaw_gateway_unavailable' });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('routes OpenClaw infer TTS failures through tts.error, not reply.error', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    fakeStt.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    fakeTts.cb.onError('openclaw_infer_tts_failed');

    expect(sentJson(peer)).toEqual([
      { t: 'stt.done', text: 'hello' },
      { t: 'reply.start', text: 'hello' },
      { t: 'reply.done', text: 'spoken reply' },
      { t: 'tts.error', message: 'openclaw_infer_tts_failed' },
    ]);
    expect(sentJson(peer)).not.toContainEqual({ t: 'reply.error', message: 'openclaw_auth_unavailable' });
    expect((session as unknown as { state: { turnInFlight: boolean } }).state.turnInFlight).toBe(false);
  });

  it('sends stt.error and resets the turn when OpenClaw infer STT fails', async () => {
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    fakeStt.cb.onError('openclaw_infer_stt_failed');

    expect(sentJson(peer)).toEqual([{ t: 'stt.error', message: 'openclaw_infer_stt_failed' }]);
    expect((session as unknown as { state: { turnInFlight: boolean } }).state.turnInFlight).toBe(false);
    expect(chatMocks.runChat).not.toHaveBeenCalled();
  });

  it('keeps an accepted turn running after the phone peer closes and replays missed control events on reconnect', async () => {
    let resolveChat!: (value: { text: string }) => void;
    chatMocks.runChat.mockReturnValue(new Promise((resolve) => { resolveChat = resolve; }));
    const onClose = vi.fn();
    const { session, peer } = makeVoiceSession({ onClose });

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    const fakeStt = sttMocks.inferCtor.mock.results[0].value;

    fakeStt.cb.onDone('hello');
    await vi.waitFor(() => expect(sentJson(peer)).toContainEqual({ t: 'reply.start', text: 'hello' }));

    (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);
    expect(onClose).not.toHaveBeenCalled();
    expect((session as unknown as { state: { closed: boolean; turnInFlight: boolean } }).state.closed).toBe(false);
    expect((session as unknown as { state: { closed: boolean; turnInFlight: boolean } }).state.turnInFlight).toBe(true);

    resolveChat({ text: 'spoken reply' });
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;
    fakeTts.cb.onOpen();
    fakeTts.cb.onDone();

    expect((session as unknown as { state: { turnInFlight: boolean } }).state.turnInFlight).toBe(false);

    const reconnectPeer = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);
    const snapshot = sentJson(reconnectPeer)[0] as { t: string; disconnectedMs?: number; events: Array<{ id: number; msg: unknown }>; turn: unknown };
    expect(snapshot.t).toBe('session.snapshot');
    expect(snapshot.events.map((event) => event.msg)).toEqual([
      { t: 'reply.done', text: 'spoken reply' },
      { t: 'tts.start', sample_rate: 24000 },
      { t: 'tts.done' },
    ]);
    expect(snapshot.disconnectedMs).toEqual(expect.any(Number));
    expect(snapshot.turn).toMatchObject({
      inFlight: false,
      phase: 'complete',
      userText: 'hello',
      replyText: 'spoken reply',
    });
  });


  it('abandons a started data-channel TTS item instead of replaying partial or later chunks on reconnect', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    fakeTts.cb.onOpen();
    fakeTts.cb.onAudio(new Uint8Array([1, 1]));
    expect(sentJson(peer)).toContainEqual({ t: 'tts.start', sample_rate: 24000 });
    expect(sentBinary(peer)).toEqual([Buffer.from([1, 1])]);

    (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);
    fakeTts.cb.onAudio(new Uint8Array([2, 2]));
    fakeTts.cb.onAudio(new Uint8Array([3, 3]));
    fakeTts.cb.onDone();

    const reconnectPeer = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);

    const json = sentJson(reconnectPeer);
    expect(flattenSnapshotEvents(json)).toContainEqual({ t: 'tts.done' });
    expectNoBufferedTtsStart(json);
    expect(sentBinary(reconnectPeer)).toEqual([]);
  });

  it('abandons a data-channel TTS turn across reconnects once any PCM reached the old session', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    fakeTts.cb.onOpen();
    fakeTts.cb.onAudio(new Uint8Array([9, 9]));
    expect(sentBinary(peer)).toEqual([Buffer.from([9, 9])]);

    (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);
    const firstReconnect = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(firstReconnect);
    expectNoBufferedTtsStart(sentJson(firstReconnect));
    expect(sentBinary(firstReconnect)).toEqual([]);

    fakeTts.cb.onAudio(new Uint8Array([10, 10]));
    fakeTts.cb.onDone();

    const laterReconnect = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(laterReconnect);
    expect(flattenSnapshotEvents(sentJson(laterReconnect))).toContainEqual({ t: 'tts.done' });
    expectNoBufferedTtsStart(sentJson(laterReconnect));
    expect(sentBinary(laterReconnect)).toEqual([]);
  });

  it('abandons started data-channel TTS replay when a later live binary send fails', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session, peer } = makeVoiceSession();
    peer.send.mockImplementation((payload: unknown) => {
      if (payload instanceof Uint8Array && Buffer.from(payload).equals(Buffer.from([2, 2]))) {
        throw new Error('second binary failed');
      }
    });

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    fakeTts.cb.onOpen();
    fakeTts.cb.onAudio(new Uint8Array([1, 1]));
    fakeTts.cb.onAudio(new Uint8Array([2, 2]));
    fakeTts.cb.onAudio(new Uint8Array([3, 3]));
    fakeTts.cb.onDone();

    expect(sentJson(peer)).toContainEqual({ t: 'tts.start', sample_rate: 24000 });
    expect(sentJson(peer)).toContainEqual({ t: 'tts.done' });
    expect(sentBinary(peer)).toContainEqual(Buffer.from([1, 1]));

    const reconnectPeer = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);

    const json = sentJson(reconnectPeer);
    expect(json[0]).toMatchObject({
      t: 'session.snapshot',
      turn: expect.objectContaining({ inFlight: false, phase: 'complete', replyText: 'spoken reply' }),
    });
    expect(flattenSnapshotEvents(json)).toContainEqual({ t: 'tts.done' });
    expectNoBufferedTtsStart(json);
    expect(sentBinary(reconnectPeer)).toEqual([]);
  });

  it('replays full data-channel TTS when the peer disconnects after tts.start but before first PCM delivery', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    fakeTts.cb.onOpen();
    expect(sentJson(peer)).toContainEqual({ t: 'tts.start', sample_rate: 24000 });
    expect(sentBinary(peer)).toEqual([]);

    (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);
    fakeTts.cb.onAudio(new Uint8Array([1, 1]));
    fakeTts.cb.onAudio(new Uint8Array([2, 2]));
    fakeTts.cb.onDone();

    const reconnectPeer = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);

    const json = sentJson(reconnectPeer);
    expect(json).toContainEqual({ t: 'tts.start', sample_rate: 24000, buffered: true, turnId: expect.any(Number), text: 'spoken reply' });
    expect(json).toContainEqual({ t: 'tts.done' });
    expect(sentBinary(reconnectPeer)).toEqual([Buffer.from([1, 1]), Buffer.from([2, 2])]);

    const duplicateReconnect = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(duplicateReconnect);
    expectNoBufferedTtsStart(sentJson(duplicateReconnect));
    expect(sentBinary(duplicateReconnect)).toEqual([]);
  });

  it('replays full WebRTC-track TTS when the phone switches away before a queued frame pumps', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session, peer } = makeVoiceSession();
    const audioSource = { onData: vi.fn() };
    (session as unknown as { audioSource: typeof audioSource; outboundStream: unknown }).audioSource = audioSource;
    (session as unknown as { outboundStream: unknown }).outboundStream = { active: true };

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    fakeTts.cb.onOpen();
    expect(sentJson(peer)).toContainEqual({ t: 'tts.start', sample_rate: 48000 });

    const queuedPcm = new Uint8Array(480).fill(1);
    fakeTts.cb.onAudio(queuedPcm);
    expect(sentBinary(peer)).toEqual([]);
    expect(audioSource.onData).not.toHaveBeenCalled();

    (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);
    fakeTts.cb.onAudio(new Uint8Array([4, 5, 6]));
    fakeTts.cb.onAudio(new Uint8Array([7, 8]));
    fakeTts.cb.onDone();

    const reconnectPeer = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);

    const json = sentJson(reconnectPeer);
    expect(flattenSnapshotEvents(json)).toContainEqual({ t: 'tts.done' });
    expect(bufferedTtsStarts(json)).toEqual([
      { t: 'tts.start', sample_rate: 24000, buffered: true, turnId: expect.any(Number), text: 'spoken reply' },
    ]);
    expect(sentBinary(reconnectPeer)).toEqual([Buffer.from(queuedPcm), Buffer.from([4, 5, 6]), Buffer.from([7, 8])]);
  });

  it('does not replay WebRTC-track TTS after the phone switches away once a frame pumps successfully', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session, peer } = makeVoiceSession();
    const audioSource = { onData: vi.fn() };
    (session as unknown as { audioSource: typeof audioSource; outboundStream: unknown }).audioSource = audioSource;
    (session as unknown as { outboundStream: unknown }).outboundStream = { active: true };

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    vi.useFakeTimers();
    try {
      fakeTts.cb.onOpen();
      expect(sentJson(peer)).toContainEqual({ t: 'tts.start', sample_rate: 48000 });

      fakeTts.cb.onAudio(new Uint8Array(480).fill(3));
      await vi.advanceTimersByTimeAsync(15);
      expect(audioSource.onData).toHaveBeenCalled();
      expect(sentBinary(peer)).toEqual([]);

      (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);
      fakeTts.cb.onAudio(new Uint8Array([4, 5, 6]));
      fakeTts.cb.onAudio(new Uint8Array([7, 8]));
      fakeTts.cb.onDone();

      const reconnectPeer = { send: vi.fn() };
      (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);

      const json = sentJson(reconnectPeer);
      expect(flattenSnapshotEvents(json)).toContainEqual({ t: 'tts.done' });
      expectNoBufferedTtsStart(json);
      expect(sentBinary(reconnectPeer)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears zero-chunk reconnect TTS after control catch-up has enough state', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'silent reply' });
    const { session, peer } = makeVoiceSession();
    const audioSource = { onData: vi.fn() };
    (session as unknown as { audioSource: typeof audioSource; outboundStream: unknown }).audioSource = audioSource;
    (session as unknown as { outboundStream: unknown }).outboundStream = { active: true };

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    fakeTts.cb.onOpen();
    (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);
    fakeTts.cb.onDone();

    expect((session as unknown as { ttsAudioTurn: unknown | null }).ttsAudioTurn).toBeNull();

    const reconnectPeer = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);
    const json = sentJson(reconnectPeer);
    expect(json[0]).toMatchObject({
      t: 'session.snapshot',
      turn: expect.objectContaining({ phase: 'complete', replyText: 'silent reply' }),
    });
    expect(json.flatMap((msg) => (msg.t === 'session.snapshot' ? msg.events.map((event: { msg: unknown }) => event.msg) : [msg]))).toContainEqual({ t: 'tts.done' });
    expectNoBufferedTtsStart(json);
    expect(sentBinary(reconnectPeer)).toEqual([]);
  });

  it('keeps an abandoned started WebRTC-track TTS item silent when completion lands after reconnect', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session, peer } = makeVoiceSession();
    const initialAudioSource = { onData: vi.fn() };
    (session as unknown as { audioSource: typeof initialAudioSource; outboundStream: unknown }).audioSource = initialAudioSource;
    (session as unknown as { outboundStream: unknown }).outboundStream = { active: true };

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    vi.useFakeTimers();
    try {
      const deliveredPcm = new Uint8Array(480).fill(1);
      fakeTts.cb.onOpen();
      fakeTts.cb.onAudio(deliveredPcm);
      expect(sentJson(peer)).toContainEqual({ t: 'tts.start', sample_rate: 48000 });
      expect(sentBinary(peer)).toEqual([]);
      await vi.advanceTimersByTimeAsync(15);
      expect(initialAudioSource.onData).toHaveBeenCalled();

      (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);

      const reconnectPeer = { destroyed: false, send: vi.fn() };
      const reconnectAudioSource = { onData: vi.fn() };
      (session as unknown as { peer: typeof reconnectPeer; connected: boolean }).peer = reconnectPeer;
      (session as unknown as { connected: boolean }).connected = true;
      (session as unknown as { audioSource: typeof reconnectAudioSource; outboundStream: unknown }).audioSource = reconnectAudioSource;
      (session as unknown as { outboundStream: unknown }).outboundStream = { active: true };

      (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);
      expectNoBufferedTtsStart(sentJson(reconnectPeer));
      expect(sentBinary(reconnectPeer)).toEqual([]);

      fakeTts.cb.onAudio(new Uint8Array([2, 0]));
      expect(queuedTtsAudio(session)).toEqual([Buffer.from(deliveredPcm), Buffer.from([2, 0])]);
      fakeTts.cb.onDone();
      await vi.advanceTimersByTimeAsync(30);

      const reconnectJson = sentJson(reconnectPeer);
      expect(reconnectAudioSource.onData).not.toHaveBeenCalled();
      expect(reconnectJson).toContainEqual({ t: 'tts.done' });
      expectNoBufferedTtsStart(reconnectJson);
      expect(sentBinary(reconnectPeer)).toEqual([]);

      const duplicateReconnect = { send: vi.fn() };
      (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(duplicateReconnect);
      const duplicateJson = sentJson(duplicateReconnect);
      expect(duplicateJson[0]).toMatchObject({
        t: 'session.snapshot',
        turn: expect.objectContaining({ inFlight: false, phase: 'complete', replyText: 'spoken reply' }),
      });
      expectNoBufferedTtsStart(duplicateJson);
      expect(sentBinary(duplicateReconnect)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replay stale WebRTC-track TTS after normal live playback completes without a session switch', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'heard reply' });
    const { session, peer } = makeVoiceSession();
    const audioSource = { onData: vi.fn() };
    (session as unknown as { audioSource: typeof audioSource; outboundStream: unknown }).audioSource = audioSource;
    (session as unknown as { outboundStream: unknown }).outboundStream = { active: true };

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;

    vi.useFakeTimers();
    try {
      fakeTts.cb.onOpen();
      fakeTts.cb.onAudio(new Uint8Array([11, 0, 12, 0]));
      fakeTts.cb.onDone();
      await vi.advanceTimersByTimeAsync(30);

      expect(audioSource.onData).toHaveBeenCalled();
      expect((session as unknown as { state: { turnInFlight: boolean } }).state.turnInFlight).toBe(false);
      expect(sentJson(peer)).toContainEqual({ t: 'tts.done' });

      const reconnectPeer = { send: vi.fn() };
      (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);

      expectNoBufferedTtsStart(sentJson(reconnectPeer));
      expect(sentBinary(reconnectPeer)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['first buffered chunk', (payload: unknown) => payload instanceof Uint8Array],
    ['tts.done', (payload: unknown) => typeof payload === 'string' && JSON.parse(payload).t === 'tts.done'],
  ])('leaves buffered TTS retryable when drain send fails at %s', async (_label, shouldThrow) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
      const { session, peer } = makeVoiceSession();

      sendControl(session, { t: 'stt.start' });
      await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
      sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
      await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
      (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);
      const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;
      fakeTts.cb.onOpen();
      fakeTts.cb.onAudio(new Uint8Array([9, 9]));
      fakeTts.cb.onAudio(new Uint8Array([10, 10]));
      fakeTts.cb.onDone();

      let failed = false;
      const failingReconnect = {
        send: vi.fn((payload: unknown) => {
          if (!failed && shouldThrow(payload)) {
            failed = true;
            throw new Error('send failed');
          }
        }),
      };
      (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(failingReconnect);
      expect(failed).toBe(true);

      const retryReconnect = { send: vi.fn() };
      (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(retryReconnect);

      expect(bufferedTtsStarts(sentJson(retryReconnect))).toHaveLength(1);
      expect(sentBinary(retryReconnect)).toEqual([Buffer.from([9, 9]), Buffer.from([10, 10])]);
      expect(sentJson(retryReconnect)).toContainEqual({ t: 'tts.done' });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('buffers generated TTS PCM after peer disconnect and drains it once on reconnect without rerunning chat or TTS', async () => {
    let resolveChat!: (value: { text: string }) => void;
    chatMocks.runChat.mockReturnValue(new Promise((resolve) => { resolveChat = resolve; }));
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
    await vi.waitFor(() => expect(sentJson(peer)).toContainEqual({ t: 'reply.start', text: 'hello' }));

    (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);
    resolveChat({ text: 'spoken reply' });
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;
    fakeTts.cb.onOpen();
    fakeTts.cb.onAudio(new Uint8Array([1, 2, 3, 4]));
    fakeTts.cb.onAudio(new Uint8Array([5, 6]));
    fakeTts.cb.onDone();

    const reconnectPeer = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);

    const json = sentJson(reconnectPeer);
    expect(json[0]).toMatchObject({ t: 'session.snapshot' });
    expect(json.slice(1)).toEqual([
      { t: 'tts.start', sample_rate: 24000, buffered: true, turnId: expect.any(Number), text: 'spoken reply' },
      { t: 'tts.done' },
    ]);
    expect(sentBinary(reconnectPeer)).toEqual([Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6])]);
    expect(chatMocks.runChat).toHaveBeenCalledTimes(1);
    expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1);
  });

  it('does not replay a drained buffered TTS turn on duplicate reconnect snapshots', async () => {
    chatMocks.runChat.mockResolvedValue({ text: 'spoken reply' });
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);
    const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;
    fakeTts.cb.onOpen();
    fakeTts.cb.onAudio(new Uint8Array([7, 8]));
    fakeTts.cb.onDone();

    const firstReconnect = { send: vi.fn() };
    const secondReconnect = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(firstReconnect);
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(secondReconnect);

    expect(bufferedTtsStarts(sentJson(firstReconnect))).toHaveLength(1);
    expect(sentBinary(firstReconnect)).toEqual([Buffer.from([7, 8])]);
    expectNoBufferedTtsStart(sentJson(secondReconnect));
    expect(sentBinary(secondReconnect)).toEqual([]);
  });

  it('clears an old buffered TTS turn when a new turn starts and replays only the replacement turn', async () => {
    chatMocks.runChat
      .mockResolvedValueOnce({ text: 'first reply' })
      .mockResolvedValueOnce({ text: 'second reply' });
    const { session, peer } = makeVoiceSession();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
    sttMocks.inferCtor.mock.results[0].value.cb.onDone('first');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
    (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);
    ttsMocks.inferTtsCtor.mock.results[0].value.cb.onOpen();
    ttsMocks.inferTtsCtor.mock.results[0].value.cb.onAudio(new Uint8Array([1, 1]));
    ttsMocks.inferTtsCtor.mock.results[0].value.cb.onDone();

    sendControl(session, { t: 'stt.start' });
    await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(2));
    sttMocks.inferCtor.mock.results[1].value.cb.onDone('second');
    await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(2));
    ttsMocks.inferTtsCtor.mock.results[1].value.cb.onOpen();
    ttsMocks.inferTtsCtor.mock.results[1].value.cb.onAudio(new Uint8Array([2, 2, 2]));
    ttsMocks.inferTtsCtor.mock.results[1].value.cb.onDone();

    const reconnectPeer = { send: vi.fn() };
    (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);

    const bufferedStarts = bufferedTtsStarts(sentJson(reconnectPeer));
    expect(bufferedStarts).toEqual([
      { t: 'tts.start', sample_rate: 24000, buffered: true, turnId: expect.any(Number), text: 'second reply' },
    ]);
    expect(sentBinary(reconnectPeer)).toEqual([Buffer.from([2, 2, 2])]);
  });

  it('drops buffered replay safely when one TTS turn exceeds the byte cap', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      chatMocks.runChat.mockResolvedValue({ text: 'huge reply' });
      const { session, peer } = makeVoiceSession();

      sendControl(session, { t: 'stt.start' });
      await vi.waitFor(() => expect(sttMocks.inferCtor).toHaveBeenCalledTimes(1));
      sttMocks.inferCtor.mock.results[0].value.cb.onDone('hello');
      await vi.waitFor(() => expect(ttsMocks.inferTtsCtor).toHaveBeenCalledTimes(1));
      (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);
      const fakeTts = ttsMocks.inferTtsCtor.mock.results[0].value;
      fakeTts.cb.onOpen();
      fakeTts.cb.onAudio(new Uint8Array(64 * 1024 * 1024 + 1));
      fakeTts.cb.onDone();

      const reconnectPeer = { send: vi.fn() };
      (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);

      expectNoBufferedTtsStart(sentJson(reconnectPeer));
      expect(sentBinary(reconnectPeer)).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('buffered TTS replay dropped'));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('reports reconnect age from the last peer detach in catch-up snapshots', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      const { session, peer } = makeVoiceSession();

      (session as unknown as { tearDownPeer(reason: string, peer?: unknown): void }).tearDownPeer('peer_closed', peer);

      now.mockReturnValue(31_001);
      const reconnectPeer = { send: vi.fn() };
      (session as unknown as { sendCatchUpSnapshot(peer: unknown): void }).sendCatchUpSnapshot(reconnectPeer);

      expect(sentJson(reconnectPeer)[0]).toMatchObject({
        t: 'session.snapshot',
        disconnectedMs: 30_001,
      });
    } finally {
      now.mockRestore();
    }
  });

});
