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

vi.mock('../daemon/src/inferSttSession.js', () => ({
  OpenClawInferSttSession: sttMocks.inferCtor,
}));

vi.mock('../daemon/src/chatSession.js', () => ({
  runChat: chatMocks.runChat,
  ChatError: class ChatError extends Error {
    code: string;

    constructor(code: string) {
      super(code);
      this.code = code;
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

import {
  createVoiceSessionState,
  decidePhoneConnection,
  VoiceSession,
  type SpeechDetectorFactory,
} from '../daemon/src/voiceSession';

function makeVoiceSession(overrides: { createSpeechDetector?: SpeechDetectorFactory } = {}) {
  const fakeVad = {
    isSpeech: vi.fn(() => true),
    destroy: vi.fn(),
  };
  const createSpeechDetector = overrides.createSpeechDetector ?? vi.fn(async () => fakeVad);
  const session = new VoiceSession({
    apiKey: 'test-key',
    sttLanguage: 'en',
    signalServer: 'https://signal.example',
    iceServers: [],
    hostPeerId: 'host-1',
    roomId: 'host-1:session-1',
    sessionId: 'session-1',
    delivery: { channel: 'discord', target: 'channel:thread-1' },
    createSpeechDetector,
    onClose: vi.fn(),
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

describe('voice session state', () => {
  it('binds one room to one session and delivery target for its lifetime', () => {
    const s = createVoiceSessionState({
      roomId: 'host-1:session-1',
      sessionId: 'session-1',
      delivery: { channel: 'discord', target: 'channel:thread-1' },
    });

    expect(s.chatTarget()).toEqual({
      sessionId: 'session-1',
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

describe('voice session OpenClaw infer STT runtime', () => {
  beforeEach(() => {
    sttMocks.inferCtor.mockClear();
    chatMocks.runChat.mockReset();
    chatMocks.runChat.mockReturnValue(new Promise(() => {}));
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
    const { session, peer } = makeVoiceSession();

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
        apiKey: 'test-key',
        sessionId: 'session-1',
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
});
