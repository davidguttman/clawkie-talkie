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

vi.mock('../daemon/src/chatSession.js', () => ({
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
import type { RecentSessionsSnapshot, SttCatalog, TtsCatalog, VoiceSettings } from '../daemon/src/protocol.js';
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
  voiceSettings?: VoiceSettings;
  ttsSessionFactory?: TtsSessionFactory;
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
    delivery: { channel: 'discord', target: 'channel:thread-1' },
    createSpeechDetector,
    ...(overrides.voiceSettings ? { voiceSettings: overrides.voiceSettings } : {}),
    ttsCatalogProvider: overrides.ttsCatalogProvider ?? defaultTtsCatalogProvider,
    ...(overrides.sttCatalogProvider ? { sttCatalogProvider: overrides.sttCatalogProvider } : {}),
    ...(overrides.recentSessionsProvider ? { recentSessionsProvider: overrides.recentSessionsProvider } : {}),
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
