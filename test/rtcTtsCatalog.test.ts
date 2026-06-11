import { act, createElement, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlMessage, RtcClientOptions, RtcStatus } from '../client/src/rtc/client';
import type { RtcContextValue, RtcRendezvous } from '../client/src/rtc/RtcContext';
import { PROTOCOL_FEATURES } from '../client/src/voice/protocol';
import type { RecentSession, SttCatalog, TtsCatalog, VoiceSettings } from '../client/src/voice/protocol';

interface FakeRtcClientInstance {
  hostPeerId: string;
  sent: ControlMessage[];
  sentBinary: Uint8Array[];
  connected: boolean;
  closed: boolean;
  sendControl(msg: ControlMessage): void;
  sendBinary(bytes: ArrayBuffer | Uint8Array): void;
  connect(): void;
  close(): void;
  emitStatus(status: RtcStatus, detail?: string): void;
  emitControl(msg: ControlMessage): void;
  emitBinary(bytes: ArrayBuffer): void;
  emitRemoteStream(stream: MediaStream): void;
}

const rtcMock = vi.hoisted(() => ({
  instances: [] as FakeRtcClientInstance[],
}));

vi.mock('../client/src/rtc/client', () => {
  class FakeRtcClient implements FakeRtcClientInstance {
    hostPeerId: string;
    sent: ControlMessage[] = [];
    sentBinary: Uint8Array[] = [];
    connected = false;
    closed = false;

    constructor(private readonly opts: RtcClientOptions) {
      this.hostPeerId = opts.hostPeerId;
      rtcMock.instances.push(this);
    }

    connect(): void {
      this.connected = true;
    }

    close(): void {
      this.closed = true;
    }

    sendControl(msg: ControlMessage): void {
      this.sent.push(msg);
    }

    sendBinary(bytes: ArrayBuffer | Uint8Array): void {
      this.sentBinary.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    }

    emitStatus(status: RtcStatus, detail?: string): void {
      this.opts.onStatusChange?.(status, detail);
    }

    emitControl(msg: ControlMessage): void {
      this.opts.onControlMessage?.(msg);
    }

    emitBinary(bytes: ArrayBuffer): void {
      this.opts.onBinaryMessage?.(bytes);
    }

    emitRemoteStream(stream: MediaStream): void {
      this.opts.onRemoteStream?.(stream);
    }
  }

  return { RtcClient: FakeRtcClient };
});

function installMinimalDom(): void {
  if (typeof document !== 'undefined' && document.createElement) return;

  const doc: Document = {
    nodeType: 9,
    defaultView: null,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: (tagName: string) => ({
      nodeType: 1,
      nodeName: tagName.toUpperCase(),
      tagName: tagName.toUpperCase(),
      ownerDocument: doc,
      style: {},
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      appendChild: () => undefined,
      removeChild: () => undefined,
      insertBefore: () => undefined,
      setAttribute: () => undefined,
    }),
  } as unknown as Document;
  const win = {
    document: doc,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
  };
  Object.defineProperty(doc, 'defaultView', { value: win, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
}

const initialSettings: VoiceSettings = {
  voice: 'eve',
  tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'eve' },
};

const rendezvous: RtcRendezvous = {
  sessionId: 'session-1',
};

const CLIENT_HELLO_FALLBACK_MS = 250;
const ALL_PROTOCOL_FEATURES = Object.values(PROTOCOL_FEATURES);

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
      voices: [{ id: 'eve', name: 'Eve' }],
    },
  ],
};

type RenderedRtc = {
  context(): RtcContextValue & {
    ttsCatalog?: TtsCatalog | null;
    requestTtsCatalog?: () => void;
    sttCatalog?: SttCatalog | null;
    requestSttCatalog?: () => void;
    recentSessions?: RecentSession[];
    recentSessionsSupportStatus?: RtcContextValue['recentSessionsSupportStatus'];
    requestRecentSessions?: () => void;
  };
  rerender(props?: Partial<RtcProviderProps>): Promise<void>;
  unmount(): Promise<void>;
};

type RtcProviderProps = {
  hostPeerId: string;
  rendezvous: RtcRendezvous | null;
  voiceSettings: VoiceSettings | null;
};

let activeRender: RenderedRtc | null = null;

async function renderRtcProvider(props: Partial<RtcProviderProps> = {}): Promise<RenderedRtc> {
  installMinimalDom();
  const { createRoot } = await import('react-dom/client');
  const { RtcProvider, useRtc } = await import('../client/src/rtc/RtcContext');

  let currentContext: RtcContextValue | null = null;
  const container = document.createElement('div');
  const root: Root = createRoot(container);
  let currentProps: RtcProviderProps = {
    hostPeerId: 'host-1',
    rendezvous,
    voiceSettings: initialSettings,
    ...props,
  };

  function Probe(): null {
    currentContext = useRtc();
    return null;
  }

  async function draw(): Promise<void> {
    await act(async () => {
      root.render(
        createElement(
          RtcProvider,
          currentProps as RtcProviderProps & { children: ReactNode },
          createElement(Probe),
        ),
      );
    });
  }

  await draw();

  activeRender = {
    context: () => {
      if (!currentContext) throw new Error('context not captured');
      return currentContext;
    },
    rerender: async (next = {}) => {
      currentProps = { ...currentProps, ...next };
      await draw();
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
  return activeRender;
}

async function openRendezvousAndAccept(roomId = 'voice-room-1'): Promise<FakeRtcClientInstance> {
  const rendezvousClient = rtcMock.instances.at(-1);
  if (!rendezvousClient) throw new Error('missing rendezvous client');
  await act(async () => {
    rendezvousClient.emitStatus('open');
  });
  await act(async () => {
    rendezvousClient.emitControl({ t: 'rendezvous.accept', roomId });
  });
  const voiceClient = rtcMock.instances.at(-1);
  if (!voiceClient || voiceClient === rendezvousClient) throw new Error('missing voice client');
  return voiceClient;
}

function sentOf(client: FakeRtcClientInstance, type: string): ControlMessage[] {
  return client.sent.filter((msg) => msg.t === type);
}

async function openWithDaemonHello(
  client: FakeRtcClientInstance,
  features: readonly string[] = ALL_PROTOCOL_FEATURES,
): Promise<void> {
  await act(async () => {
    client.emitStatus('open');
  });
  await act(async () => {
    client.emitControl({ t: 'daemon.hello', protocol: 1, features: [...features] });
  });
}

async function openWithLegacyFallback(client: FakeRtcClientInstance): Promise<void> {
  vi.useFakeTimers();
  await act(async () => {
    client.emitStatus('open');
  });
  await act(async () => {
    vi.advanceTimersByTime(CLIENT_HELLO_FALLBACK_MS);
  });
}

afterEach(async () => {
  if (activeRender) await activeRender.unmount();
  activeRender = null;
  rtcMock.instances.length = 0;
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('RtcProvider TTS catalog and settings sync', () => {
  it('waits for daemon.hello before the initial rendezvous.join on the host lane', async () => {
    await renderRtcProvider({ voiceSettings: { voice: '', tts: {}, stt: {} } });
    const rendezvousClient = rtcMock.instances[0];

    await act(async () => {
      rendezvousClient.emitStatus('open');
    });

    expect(rendezvousClient.sent).toEqual([
      { t: 'client.hello', protocol: 1, wants: ALL_PROTOCOL_FEATURES },
    ]);

    await act(async () => {
      rendezvousClient.emitControl({ t: 'daemon.hello', protocol: 1, features: ALL_PROTOCOL_FEATURES });
    });

    expect(sentOf(rendezvousClient, 'rendezvous.join')).toEqual([
      { t: 'rendezvous.join', sessionId: 'session-1' },
    ]);
  });

  it('does not send rendezvous.join after daemon.unsupported on the host lane', async () => {
    const rendered = await renderRtcProvider({ voiceSettings: { voice: '', tts: {}, stt: {} } });
    const rendezvousClient = rtcMock.instances[0];

    await act(async () => {
      rendezvousClient.emitStatus('open');
    });
    await act(async () => {
      rendezvousClient.emitControl({
        t: 'daemon.unsupported',
        minProtocol: 1,
        maxProtocol: 1,
        message: 'unsupported_daemon_protocol',
      });
    });

    expect(rendered.context().status).toBe('error');
    expect(sentOf(rendezvousClient, 'rendezvous.join')).toEqual([]);
  });

  it('falls back and joins an old host daemon that rejects client.hello as unexpected_message', async () => {
    const rendered = await renderRtcProvider({ voiceSettings: { voice: '', tts: {}, stt: {} } });
    const rendezvousClient = rtcMock.instances[0];

    await act(async () => {
      rendezvousClient.emitStatus('open');
    });
    expect(rendezvousClient.sent).toEqual([
      { t: 'client.hello', protocol: 1, wants: ALL_PROTOCOL_FEATURES },
    ]);

    await act(async () => {
      rendezvousClient.emitControl({ t: 'rendezvous.error', message: 'unexpected_message' });
    });

    expect(rendered.context().status).toBe('open');
    expect(rendered.context().detail).toBeUndefined();
    expect(sentOf(rendezvousClient, 'rendezvous.join')).toEqual([
      { t: 'rendezvous.join', sessionId: 'session-1' },
    ]);
  });

  it('keeps a delayed unexpected_message benign after legacy host fallback', async () => {
    const rendered = await renderRtcProvider({ voiceSettings: { voice: '', tts: {}, stt: {} } });
    const rendezvousClient = rtcMock.instances[0];

    await openWithLegacyFallback(rendezvousClient);

    expect(sentOf(rendezvousClient, 'rendezvous.join')).toEqual([
      { t: 'rendezvous.join', sessionId: 'session-1' },
    ]);

    await act(async () => {
      rendezvousClient.emitControl({ t: 'rendezvous.error', message: 'unexpected_message' });
    });

    expect(rendered.context().status).toBe('open');
    expect(rendered.context().detail).toBeUndefined();
    expect(sentOf(rendezvousClient, 'rendezvous.join')).toEqual([
      { t: 'rendezvous.join', sessionId: 'session-1' },
    ]);

    await act(async () => {
      rendezvousClient.emitControl({ t: 'rendezvous.accept', roomId: 'voice-room-1' });
    });

    const voiceClient = rtcMock.instances.at(-1)!;
    expect(voiceClient.hostPeerId).toBe('voice-room-1');
  });

  it('keeps a delayed unexpected_message benign around an accepted legacy host join', async () => {
    const rendered = await renderRtcProvider({ voiceSettings: { voice: '', tts: {}, stt: {} } });
    const rendezvousClient = rtcMock.instances[0];

    await openWithLegacyFallback(rendezvousClient);
    expect(sentOf(rendezvousClient, 'rendezvous.join')).toEqual([
      { t: 'rendezvous.join', sessionId: 'session-1' },
    ]);

    await act(async () => {
      rendezvousClient.emitControl({ t: 'rendezvous.accept', roomId: 'voice-room-1' });
      rendezvousClient.emitControl({ t: 'rendezvous.error', message: 'unexpected_message' });
    });

    const voiceClient = rtcMock.instances.at(-1)!;
    expect(voiceClient.hostPeerId).toBe('voice-room-1');
    expect(rendered.context().status).not.toBe('error');
    expect(rendered.context().detail).toBeUndefined();

    await openWithLegacyFallback(voiceClient);
    expect(sentOf(voiceClient, 'tts.catalog.request')).toEqual([{ t: 'tts.catalog.request' }]);
  });

  it('still surfaces real rendezvous errors after legacy host fallback', async () => {
    const rendered = await renderRtcProvider({ voiceSettings: { voice: '', tts: {}, stt: {} } });
    const rendezvousClient = rtcMock.instances[0];

    await openWithLegacyFallback(rendezvousClient);

    await act(async () => {
      rendezvousClient.emitControl({ t: 'rendezvous.error', message: 'missing_session' });
    });

    expect(rendered.context().status).toBe('error');
    expect(rendered.context().detail).toBe('missing_session');
  });

  it('sends client.hello before feature requests on the voice lane and gates them by daemon features', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();

    await openWithDaemonHello(voiceClient, [PROTOCOL_FEATURES.sttCatalog]);

    expect(voiceClient.sent[0]).toEqual({ t: 'client.hello', protocol: 1, wants: ALL_PROTOCOL_FEATURES });
    expect(sentOf(voiceClient, 'tts.catalog.request')).toEqual([]);
    expect(sentOf(voiceClient, 'stt.catalog.request')).toEqual([{ t: 'stt.catalog.request' }]);
    expect(sentOf(voiceClient, 'sessions.list.subscribe')).toEqual([]);
    expect(sentOf(voiceClient, 'sessions.catalog.request')).toEqual([]);
    expect(rendered.context().recentSessionsSupportStatus).toBe('unsupported');
  });

  it('keeps rendezvous and voice room capabilities separate', async () => {
    await renderRtcProvider();
    const rendezvousClient = rtcMock.instances[0];

    await openWithDaemonHello(rendezvousClient, []);
    await act(async () => {
      rendezvousClient.emitControl({ t: 'rendezvous.accept', roomId: 'voice-room-1' });
    });
    const voiceClient = rtcMock.instances[1];

    await openWithDaemonHello(voiceClient);

    expect(sentOf(rendezvousClient, 'tts.catalog.request')).toEqual([]);
    expect(sentOf(voiceClient, 'tts.catalog.request')).toEqual([{ t: 'tts.catalog.request' }]);
    expect(sentOf(voiceClient, 'stt.catalog.request')).toEqual([{ t: 'stt.catalog.request' }]);
    expect(sentOf(voiceClient, 'sessions.list.subscribe')).toEqual([{ t: 'sessions.list.subscribe' }]);
    expect(sentOf(voiceClient, 'sessions.catalog.request')).toEqual([{ t: 'sessions.catalog.request' }]);
  });

  it('keeps no-hello daemon compatibility by sending existing feature requests after fallback', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();

    vi.useFakeTimers();
    await act(async () => {
      voiceClient.emitStatus('open');
    });

    expect(voiceClient.sent[0]).toEqual({ t: 'client.hello', protocol: 1, wants: ALL_PROTOCOL_FEATURES });
    expect(sentOf(voiceClient, 'tts.catalog.request')).toEqual([]);
    expect(sentOf(voiceClient, 'stt.catalog.request')).toEqual([]);
    expect(sentOf(voiceClient, 'sessions.list.subscribe')).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(CLIENT_HELLO_FALLBACK_MS);
    });

    expect(sentOf(voiceClient, 'tts.catalog.request')).toEqual([{ t: 'tts.catalog.request' }]);
    expect(sentOf(voiceClient, 'stt.catalog.request')).toEqual([{ t: 'stt.catalog.request' }]);
    expect(sentOf(voiceClient, 'sessions.list.subscribe')).toEqual([{ t: 'sessions.list.subscribe' }]);
    expect(sentOf(voiceClient, 'sessions.catalog.request')).toEqual([{ t: 'sessions.catalog.request' }]);
    expect(rendered.context().recentSessionsSupportStatus).toBe('probing');
  });

  it('applies a late daemon.hello after no-hello fallback', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();

    await openWithLegacyFallback(voiceClient);

    expect(sentOf(voiceClient, 'tts.catalog.request')).toHaveLength(1);
    expect(sentOf(voiceClient, 'stt.catalog.request')).toHaveLength(1);

    await act(async () => {
      voiceClient.emitControl({
        t: 'daemon.hello',
        protocol: 1,
        features: [PROTOCOL_FEATURES.sttCatalog],
      });
    });

    await act(async () => {
      rendered.context().requestTtsCatalog?.();
      rendered.context().sendControl({ t: 'tts.catalog.request' });
      rendered.context().requestSttCatalog?.();
    });

    expect(sentOf(voiceClient, 'tts.catalog.request')).toHaveLength(1);
    expect(sentOf(voiceClient, 'stt.catalog.request')).toHaveLength(2);
  });

  it('sets a daemon-focused protocol mismatch detail on daemon.unsupported', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();

    await act(async () => {
      voiceClient.emitStatus('open');
      voiceClient.emitControl({
        t: 'daemon.unsupported',
        minProtocol: 1,
        maxProtocol: 1,
        message: 'unsupported_daemon_protocol',
      });
    });

    expect(rendered.context().status).toBe('error');
    expect(rendered.context().detail).toBe('unsupported_daemon_protocol');
    expect(sentOf(voiceClient, 'tts.catalog.request')).toEqual([]);
    expect(sentOf(voiceClient, 'sessions.catalog.request')).toEqual([]);
  });

  it('keeps daemon.unsupported terminal even if a later daemon.hello arrives', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();

    await act(async () => {
      voiceClient.emitStatus('open');
      voiceClient.emitControl({
        t: 'daemon.unsupported',
        minProtocol: 1,
        maxProtocol: 1,
        message: 'unsupported_daemon_protocol',
      });
      voiceClient.emitControl({
        t: 'daemon.hello',
        protocol: 1,
        features: ALL_PROTOCOL_FEATURES,
      });
    });

    await act(async () => {
      rendered.context().requestTtsCatalog?.();
      rendered.context().sendControl({ t: 'stt.start' });
    });

    expect(rendered.context().status).toBe('error');
    expect(rendered.context().detail).toBe('unsupported_daemon_protocol');
    expect(sentOf(voiceClient, 'tts.catalog.request')).toEqual([]);
    expect(sentOf(voiceClient, 'stt.start')).toEqual([]);
  });

  it('blocks outgoing binary after daemon.unsupported on the voice lane', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();

    await act(async () => {
      voiceClient.emitStatus('open');
      voiceClient.emitControl({
        t: 'daemon.unsupported',
        minProtocol: 1,
        maxProtocol: 1,
        message: 'unsupported_daemon_protocol',
      });
    });

    await act(async () => {
      rendered.context().sendBinary(new Uint8Array([1, 2, 3]));
    });

    expect(voiceClient.sentBinary).toEqual([]);
  });

  it('rejects malformed daemon.hello protocol instead of negotiating v1 features', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();

    await act(async () => {
      voiceClient.emitStatus('open');
      voiceClient.emitControl({
        t: 'daemon.hello',
        protocol: 2,
        features: ALL_PROTOCOL_FEATURES,
      });
    });

    await act(async () => {
      rendered.context().requestTtsCatalog?.();
      rendered.context().sendControl({ t: 'stt.start' });
    });

    expect(rendered.context().status).toBe('error');
    expect(rendered.context().detail).toBe('unsupported_daemon_protocol');
    expect(sentOf(voiceClient, 'tts.catalog.request')).toEqual([]);
    expect(sentOf(voiceClient, 'stt.start')).toEqual([]);
  });

  it('omits provider, model, and voice hints from initial rendezvous.join for Default settings', async () => {
    await renderRtcProvider({ voiceSettings: { voice: '', tts: {}, stt: {} } });
    const rendezvousClient = rtcMock.instances[0];

    await openWithDaemonHello(rendezvousClient);

    expect(sentOf(rendezvousClient, 'rendezvous.join')).toEqual([
      {
        t: 'rendezvous.join',
        sessionId: 'session-1',
      },
    ]);
  });

  it('includes sessionKey, channel, target, and accountId routing metadata in the initial rendezvous.join', async () => {
    await renderRtcProvider({
      rendezvous: {
        sessionId: 'session-uuid',
        sessionKey: 'agent:main:discord:channel:thread-1',
        channel: 'discord',
        target: 'channel:thread-1',
        accountId: 'acct-1',
      },
      voiceSettings: { voice: '', tts: {}, stt: {} },
    });
    const rendezvousClient = rtcMock.instances[0];

    await openWithDaemonHello(rendezvousClient);

    expect(sentOf(rendezvousClient, 'rendezvous.join')).toEqual([
      {
        t: 'rendezvous.join',
        sessionId: 'session-uuid',
        sessionKey: 'agent:main:discord:channel:thread-1',
        channel: 'discord',
        target: 'channel:thread-1',
        accountId: 'acct-1',
      },
    ]);
  });

  it('requests the TTS catalog once after the voice room opens', async () => {
    await renderRtcProvider();
    const rendezvousClient = rtcMock.instances[0];

    await openWithDaemonHello(rendezvousClient);
    expect(sentOf(rendezvousClient, 'tts.catalog.request')).toHaveLength(0);

    await act(async () => {
      rendezvousClient.emitControl({ t: 'rendezvous.accept', roomId: 'voice-room-1' });
    });
    const voiceClient = rtcMock.instances[1];
    expect(sentOf(voiceClient, 'tts.catalog.request')).toHaveLength(0);

    await openWithLegacyFallback(voiceClient);
    expect(sentOf(voiceClient, 'tts.catalog.request')).toEqual([{ t: 'tts.catalog.request' }]);

    await activeRender!.rerender({ voiceSettings: { ...initialSettings } });
    expect(sentOf(voiceClient, 'tts.catalog.request')).toHaveLength(1);
  });

  it('exposes received TTS catalogs to context consumers', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await act(async () => {
      voiceClient.emitStatus('open');
      voiceClient.emitControl({ t: 'tts.catalog', catalog });
    });

    expect(rendered.context().ttsCatalog).toEqual(catalog);
  });

  it('does not send manual TTS catalog requests while still in the rendezvous room', async () => {
    const rendered = await renderRtcProvider();
    const rendezvousClient = rtcMock.instances[0];

    await act(async () => {
      rendered.context().requestTtsCatalog?.();
    });
    expect(sentOf(rendezvousClient, 'tts.catalog.request')).toHaveLength(0);

    await act(async () => {
      rendezvousClient.emitStatus('open');
    });
    await act(async () => {
      rendered.context().requestTtsCatalog?.();
    });

    expect(sentOf(rendezvousClient, 'tts.catalog.request')).toHaveLength(0);
  });

  it('does not send manual TTS catalog requests before the voice room opens', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();

    await act(async () => {
      rendered.context().requestTtsCatalog?.();
    });

    expect(sentOf(voiceClient, 'tts.catalog.request')).toHaveLength(0);
  });

  it('waits for daemon.hello before sending voice-room settings.update', async () => {
    await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();

    await act(async () => {
      voiceClient.emitStatus('open');
    });

    expect(sentOf(voiceClient, 'settings.update')).toEqual([]);

    await act(async () => {
      voiceClient.emitControl({ t: 'daemon.hello', protocol: 1, features: ALL_PROTOCOL_FEATURES });
    });

    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: initialSettings },
    ]);
  });

  it('waits for legacy fallback before sending voice-room settings.update', async () => {
    await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();

    vi.useFakeTimers();
    await act(async () => {
      voiceClient.emitStatus('open');
    });

    expect(sentOf(voiceClient, 'settings.update')).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(CLIENT_HELLO_FALLBACK_MS - 1);
    });
    expect(sentOf(voiceClient, 'settings.update')).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: initialSettings },
    ]);
  });

  it('lets context consumers request the TTS catalog explicitly', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);

    await act(async () => {
      rendered.context().requestTtsCatalog?.();
    });

    expect(sentOf(voiceClient, 'tts.catalog.request')).toHaveLength(2);
  });

  it('sends settings.update when only the legacy voice alias changes and canonical voice is absent in an open voice room', async () => {
    const previousSettings: VoiceSettings = {
      voice: 'eve',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts' },
    };
    await renderRtcProvider({ voiceSettings: previousSettings });
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);
    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      {
        t: 'settings.update',
        settings: {
          voice: 'eve',
          tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'eve' },
        },
      },
    ]);

    const legacyOnlyChange: VoiceSettings = {
      voice: 'ara',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts' },
    };
    await activeRender!.rerender({ voiceSettings: legacyOnlyChange });

    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      {
        t: 'settings.update',
        settings: {
          voice: 'eve',
          tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'eve' },
        },
      },
      {
        t: 'settings.update',
        settings: {
          voice: 'ara',
          tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'ara' },
        },
      },
    ]);
  });

  it('prefers canonical TTS voice over a stale legacy voice alias in an open voice room', async () => {
    const previousSettings: VoiceSettings = {
      voice: 'rex',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'rex' },
    };
    await renderRtcProvider({ voiceSettings: previousSettings });
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);
    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: previousSettings },
    ]);

    const canonicalOnlyChange: VoiceSettings = {
      voice: 'rex',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
    };
    await activeRender!.rerender({ voiceSettings: canonicalOnlyChange });

    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: previousSettings },
      {
        t: 'settings.update',
        settings: {
          voice: 'nova',
          tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
        },
      },
    ]);
  });

  it('sends settings.update when the canonical TTS voice changes in an open voice room', async () => {
    await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);
    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: initialSettings },
    ]);

    const canonicalVoiceChange: VoiceSettings = {
      voice: 'ara',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'ara' },
    };
    await activeRender!.rerender({ voiceSettings: canonicalVoiceChange });

    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: initialSettings },
      { t: 'settings.update', settings: canonicalVoiceChange },
    ]);
  });

  it('sends full canonical TTS settings and dedupes by provider, model, and voice', async () => {
    await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);
    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: initialSettings },
    ]);

    const sameVoiceDifferentProvider: VoiceSettings = {
      voice: 'eve',
      tts: { providerId: 'elevenlabs', model: 'eleven_turbo_v2_5', voice: 'eve' },
    };
    await activeRender!.rerender({ voiceSettings: sameVoiceDifferentProvider });
    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: initialSettings },
      { t: 'settings.update', settings: sameVoiceDifferentProvider },
    ]);

    await activeRender!.rerender({ voiceSettings: { ...sameVoiceDifferentProvider } });
    expect(sentOf(voiceClient, 'settings.update')).toHaveLength(2);
  });

  it('sends an explicit clearing settings.update when explicit settings change to Default', async () => {
    await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);
    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: initialSettings },
    ]);

    await activeRender!.rerender({ voiceSettings: { voice: '', tts: {}, stt: {} } });

    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: initialSettings },
      { t: 'settings.update', settings: {} },
    ]);
  });

  it('clears explicit rendezvous.join settings when switched to Default before the voice room opens', async () => {
    await renderRtcProvider();
    const rendezvousClient = rtcMock.instances[0];

    await openWithDaemonHello(rendezvousClient);
    expect(sentOf(rendezvousClient, 'rendezvous.join')).toEqual([
      {
        t: 'rendezvous.join',
        sessionId: 'session-1',
        settings: initialSettings,
      },
    ]);

    await activeRender!.rerender({ voiceSettings: { voice: '', tts: {}, stt: {} } });
    await act(async () => {
      rendezvousClient.emitControl({ t: 'rendezvous.accept', roomId: 'voice-room-1' });
    });
    const voiceClient = rtcMock.instances[1];
    await openWithLegacyFallback(voiceClient);

    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: {} },
    ]);
  });

  it('resets settings dedupe after returning to a rendezvous room', async () => {
    await renderRtcProvider();
    const firstVoiceClient = await openRendezvousAndAccept('voice-room-1');
    await openWithLegacyFallback(firstVoiceClient);
    expect(sentOf(firstVoiceClient, 'settings.update')).toHaveLength(1);

    await activeRender!.rerender({
      hostPeerId: 'host-2',
      rendezvous: { ...rendezvous, sessionId: 'session-2' },
      voiceSettings: { ...initialSettings },
    });
    const secondRendezvousClient = rtcMock.instances.at(-1)!;
    await act(async () => {
      secondRendezvousClient.emitStatus('open');
      secondRendezvousClient.emitControl({ t: 'rendezvous.accept', roomId: 'voice-room-2' });
    });
    const secondVoiceClient = rtcMock.instances.at(-1)!;
    await openWithLegacyFallback(secondVoiceClient);

    expect(sentOf(secondVoiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: initialSettings },
    ]);
  });
});



  it('expands reconnect snapshots into ordered missed control events for listeners', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    const seen: ControlMessage[] = [];
    const detach = rendered.context().addControlListener((msg) => seen.push(msg));

    await act(async () => {
      voiceClient.emitControl({
        t: 'session.snapshot',
        roomId: 'voice-room-1',
        latestEventId: 3,
        turn: {
          inFlight: false,
          phase: 'complete',
          latestEventId: 3,
          userText: 'hello',
          replyText: 'spoken reply',
        },
        events: [
          { id: 3, msg: { t: 'tts.done' } },
          { id: 2, msg: { t: 'reply.done', text: 'spoken reply' } },
        ],
      });
    });

    detach();
    expect(seen.map((msg) => msg.t)).toEqual(['session.snapshot', 'reply.done', 'tts.done']);
  });

describe('RtcProvider recent session picker sync', () => {
  const sessions: RecentSession[] = [
    {
      sessionId: 'session-2',
      sessionKey: 'agent:kamaji:discord:channel:t2',
      agent: 'kamaji',
      channel: 'discord',
      target: 'channel:t2',
      lastActivity: '2026-05-05T19:00:00.000Z',
      displayLabel: 'planning',
    },
  ];

  it('uses the host-only dashboard lane for session discovery without rendezvous.join', async () => {
    const rendered = await renderRtcProvider({ rendezvous: null, voiceSettings: null });
    const dashboardClient = rtcMock.instances[0];

    expect(dashboardClient.hostPeerId).toBe('host-1');
    await openWithLegacyFallback(dashboardClient);

    expect(sentOf(dashboardClient, 'rendezvous.join')).toEqual([]);
    expect(sentOf(dashboardClient, 'sessions.list.subscribe')).toEqual([{ t: 'sessions.list.subscribe' }]);
    expect(sentOf(dashboardClient, 'sessions.catalog.request')).toEqual([{ t: 'sessions.catalog.request' }]);
    expect(rendered.context().recentSessionsSupportStatus).toBe('probing');

    await act(async () => {
      rendered.context().requestRecentSessions?.();
    });
    expect(sentOf(dashboardClient, 'sessions.list.request')).toEqual([{ t: 'sessions.list.request' }]);
    expect(sentOf(dashboardClient, 'sessions.catalog.request')).toEqual([
      { t: 'sessions.catalog.request' },
      { t: 'sessions.catalog.request' },
    ]);
  });

  it('subscribes to recent sessions once after the voice room opens', async () => {
    await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);

    expect(sentOf(voiceClient, 'sessions.list.subscribe')).toEqual([{ t: 'sessions.list.subscribe' }]);
    expect(sentOf(voiceClient, 'sessions.catalog.request')).toEqual([{ t: 'sessions.catalog.request' }]);
    expect(activeRender!.context().recentSessionsSupportStatus).toBe('probing');

    await activeRender!.rerender({ voiceSettings: { ...initialSettings } });
    expect(sentOf(voiceClient, 'sessions.list.subscribe')).toHaveLength(1);
    expect(sentOf(voiceClient, 'sessions.catalog.request')).toHaveLength(1);
  });

  it('exposes received recent sessions, marks support, and allows manual refresh in an open voice room', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);
    expect(rendered.context().recentSessionsSupportStatus).toBe('probing');

    await act(async () => {
      voiceClient.emitControl({
        t: 'sessions.list',
        generatedAt: '2026-05-05T19:00:00.000Z',
        sessions,
      });
    });

    expect(rendered.context().recentSessions).toEqual(sessions);
    expect(rendered.context().recentSessionsGeneratedAt).toBe('2026-05-05T19:00:00.000Z');
    expect(rendered.context().recentSessionsSupportStatus).toBe('supported');

    await act(async () => {
      rendered.context().requestRecentSessions?.();
    });
    expect(sentOf(voiceClient, 'sessions.list.request')).toEqual([{ t: 'sessions.list.request' }]);
    expect(sentOf(voiceClient, 'sessions.catalog.request')).toEqual([
      { t: 'sessions.catalog.request' },
      { t: 'sessions.catalog.request' },
    ]);
  });

  it('increments a recent-session response sequence for repeated list responses with the same generatedAt', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);

    expect(rendered.context().recentSessionsResponseSeq).toBe(0);

    await act(async () => {
      voiceClient.emitControl({
        t: 'sessions.list',
        generatedAt: '2026-05-05T19:00:00.000Z',
        sessions,
      });
    });
    expect(rendered.context().recentSessionsResponseSeq).toBe(1);

    await act(async () => {
      voiceClient.emitControl({
        t: 'sessions.list',
        generatedAt: '2026-05-05T19:00:00.000Z',
        sessions,
      });
    });
    expect(rendered.context().recentSessionsResponseSeq).toBe(2);
    expect(rendered.context().recentSessionsGeneratedAt).toBe('2026-05-05T19:00:00.000Z');
    expect(rendered.context().recentSessions).toEqual(sessions);
  });

  it('accepts legacy recent-session catalog responses from older daemons', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await act(async () => {
      voiceClient.emitStatus('open');
      voiceClient.emitControl({
        t: 'sessions.catalog',
        catalog: {
          generatedAt: '2026-05-05T19:01:00.000Z',
          sessions,
        },
      });
    });

    expect(rendered.context().recentSessions).toEqual(sessions);
    expect(rendered.context().recentSessionsGeneratedAt).toBe('2026-05-05T19:01:00.000Z');
    expect(rendered.context().recentSessionsSupportStatus).toBe('supported');
  });

  it('increments the response sequence for repeated legacy catalog responses', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await act(async () => {
      voiceClient.emitStatus('open');
      voiceClient.emitControl({
        t: 'sessions.catalog',
        catalog: {
          generatedAt: '2026-05-05T19:01:00.000Z',
          sessions,
        },
      });
    });
    expect(rendered.context().recentSessionsResponseSeq).toBe(1);

    await act(async () => {
      voiceClient.emitControl({
        t: 'sessions.catalog',
        catalog: {
          generatedAt: '2026-05-05T19:01:00.000Z',
          sessions,
        },
      });
    });
    expect(rendered.context().recentSessionsResponseSeq).toBe(2);
  });

  it('marks recent-session support unsupported after a quiet probe timeout', async () => {
    vi.useFakeTimers();
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);

    expect(rendered.context().recentSessionsSupportStatus).toBe('probing');

    await act(async () => {
      vi.advanceTimersByTime(11_999);
    });
    expect(rendered.context().recentSessionsSupportStatus).toBe('probing');

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(rendered.context().recentSessionsSupportStatus).toBe('unsupported');
  });


  it('recovers recent-session support when a valid response arrives after the probe timeout', async () => {
    vi.useFakeTimers();
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);
    await act(async () => {
      vi.advanceTimersByTime(12_000);
    });

    expect(rendered.context().recentSessionsSupportStatus).toBe('unsupported');

    await act(async () => {
      voiceClient.emitControl({
        t: 'sessions.list',
        generatedAt: '2026-05-05T19:00:00.000Z',
        sessions,
      });
    });

    expect(rendered.context().recentSessions).toEqual(sessions);
    expect(rendered.context().recentSessionsGeneratedAt).toBe('2026-05-05T19:00:00.000Z');
    expect(rendered.context().recentSessionsSupportStatus).toBe('supported');
  });

  it('lets manual refresh retry from unsupported before a later response marks support', async () => {
    vi.useFakeTimers();
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);
    await act(async () => {
      vi.advanceTimersByTime(12_000);
    });

    expect(rendered.context().recentSessionsSupportStatus).toBe('unsupported');

    await act(async () => {
      rendered.context().requestRecentSessions?.();
    });

    expect(rendered.context().recentSessionsSupportStatus).toBe('probing');
    expect(sentOf(voiceClient, 'sessions.list.request')).toEqual([{ t: 'sessions.list.request' }]);

    await act(async () => {
      voiceClient.emitControl({
        t: 'sessions.catalog',
        catalog: {
          generatedAt: '2026-05-05T19:01:00.000Z',
          sessions,
        },
      });
    });

    expect(rendered.context().recentSessionsSupportStatus).toBe('supported');
    expect(rendered.context().recentSessionsGeneratedAt).toBe('2026-05-05T19:01:00.000Z');
  });

  it('does not block ordinary old-daemon voice controls when recent-session probes are ignored', async () => {
    vi.useFakeTimers();
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    const seen: ControlMessage[] = [];
    const detach = rendered.context().addControlListener((msg) => seen.push(msg));

    await openWithLegacyFallback(voiceClient);

    expect(sentOf(voiceClient, 'sessions.list.subscribe')).toEqual([{ t: 'sessions.list.subscribe' }]);
    expect(sentOf(voiceClient, 'sessions.catalog.request')).toEqual([{ t: 'sessions.catalog.request' }]);

    await act(async () => {
      voiceClient.emitControl({ t: 'stt.done', text: 'hello' });
      voiceClient.emitControl({ t: 'reply.done', text: 'spoken reply' });
      voiceClient.emitControl({ t: 'tts.start', sample_rate: 24000 });
      voiceClient.emitControl({ t: 'tts.done' });
      vi.advanceTimersByTime(12_000);
    });

    expect(rendered.context().status).toBe('open');
    expect(rendered.context().recentSessionsSupportStatus).toBe('unsupported');
    expect(seen.map((msg) => msg.t)).toEqual(['stt.done', 'reply.done', 'tts.start', 'tts.done']);

    await act(async () => {
      rendered.context().requestRecentSessions?.();
    });
    expect(sentOf(voiceClient, 'sessions.list.request')).toEqual([{ t: 'sessions.list.request' }]);
    expect(sentOf(voiceClient, 'sessions.catalog.request')).toEqual([
      { t: 'sessions.catalog.request' },
      { t: 'sessions.catalog.request' },
    ]);

    detach();
  });

  it('resets recent-session support when reconnecting to a new selected session', async () => {
    const rendered = await renderRtcProvider();
    const firstVoiceClient = await openRendezvousAndAccept('voice-room-1');
    await act(async () => {
      firstVoiceClient.emitStatus('open');
      firstVoiceClient.emitControl({
        t: 'sessions.list',
        generatedAt: '2026-05-05T19:00:00.000Z',
        sessions,
      });
    });
    expect(rendered.context().recentSessionsSupportStatus).toBe('supported');

    await activeRender!.rerender({ rendezvous: { sessionId: 'session-2' } });
    expect(rendered.context().recentSessionsSupportStatus).toBe('unknown');
  });

  it('sends rendezvous.join on the already-open dashboard lane when a created session is selected', async () => {
    const rendered = await renderRtcProvider({ rendezvous: null, voiceSettings: null });
    const dashboardClient = rtcMock.instances[0];

    await openWithDaemonHello(dashboardClient);
    expect(sentOf(dashboardClient, 'rendezvous.join')).toEqual([]);

    // App reacts to sessions.created by selecting the new session, which
    // flips the rendezvous prop while the host lane is already open.
    await activeRender!.rerender({ rendezvous: { sessionId: 'session-created-1' } });

    expect(rendered.context().status).toBe('open');
    expect(sentOf(dashboardClient, 'rendezvous.join')).toEqual([
      { t: 'rendezvous.join', sessionId: 'session-created-1' },
    ]);

    // A re-render with an equivalent (new identity) rendezvous object must
    // not repeat the join while waiting for rendezvous.accept.
    await activeRender!.rerender({ rendezvous: { sessionId: 'session-created-1' } });
    expect(sentOf(dashboardClient, 'rendezvous.join')).toHaveLength(1);

    await act(async () => {
      dashboardClient.emitControl({ t: 'rendezvous.accept', roomId: 'voice-room-created' });
    });
    const voiceClient = rtcMock.instances.at(-1)!;
    expect(voiceClient).not.toBe(dashboardClient);
    expect(voiceClient.hostPeerId).toBe('voice-room-created');
    expect(rendered.context().status).not.toBe('error');
  });

  it('joins on the dashboard lane after a legacy (no-hello) handshake when a session is selected', async () => {
    await renderRtcProvider({ rendezvous: null, voiceSettings: null });
    const dashboardClient = rtcMock.instances[0];

    await openWithLegacyFallback(dashboardClient);
    expect(sentOf(dashboardClient, 'rendezvous.join')).toEqual([]);

    await activeRender!.rerender({ rendezvous: { sessionId: 'session-old-1' } });

    expect(sentOf(dashboardClient, 'rendezvous.join')).toEqual([
      { t: 'rendezvous.join', sessionId: 'session-old-1' },
    ]);
  });

  it('joins after the legacy fallback when the session is selected before the host handshake resolves', async () => {
    vi.useFakeTimers();
    await renderRtcProvider({ rendezvous: null, voiceSettings: null });
    const dashboardClient = rtcMock.instances[0];

    // Lane opens; client.hello is in flight, negotiation still pending.
    await act(async () => {
      dashboardClient.emitStatus('open');
    });
    expect(sentOf(dashboardClient, 'rendezvous.join')).toEqual([]);

    // Session selected before the daemon answered the handshake.
    await activeRender!.rerender({ rendezvous: { sessionId: 'session-fast-select' } });

    await act(async () => {
      vi.advanceTimersByTime(CLIENT_HELLO_FALLBACK_MS);
    });

    expect(sentOf(dashboardClient, 'rendezvous.join')).toEqual([
      { t: 'rendezvous.join', sessionId: 'session-fast-select' },
    ]);
  });

  it('joins on a late daemon.hello when the session is selected before the host handshake resolves', async () => {
    await renderRtcProvider({ rendezvous: null, voiceSettings: null });
    const dashboardClient = rtcMock.instances[0];

    await act(async () => {
      dashboardClient.emitStatus('open');
    });

    await activeRender!.rerender({ rendezvous: { sessionId: 'session-fast-select' } });
    expect(sentOf(dashboardClient, 'rendezvous.join')).toEqual([]);

    await act(async () => {
      dashboardClient.emitControl({ t: 'daemon.hello', protocol: 1, features: ALL_PROTOCOL_FEATURES });
    });

    expect(sentOf(dashboardClient, 'rendezvous.join')).toEqual([
      { t: 'rendezvous.join', sessionId: 'session-fast-select' },
    ]);
  });

  it('returns to the rendezvous room when the selected session changes on the same host', async () => {
    await renderRtcProvider();
    const firstVoiceClient = await openRendezvousAndAccept('voice-room-1');
    await openWithLegacyFallback(firstVoiceClient);

    await activeRender!.rerender({ rendezvous: { sessionId: 'session-2' } });
    const secondRendezvousClient = rtcMock.instances.at(-1)!;
    expect(secondRendezvousClient.hostPeerId).toBe('host-1');
    expect(secondRendezvousClient).not.toBe(firstVoiceClient);

    await openWithDaemonHello(secondRendezvousClient);
    expect(sentOf(secondRendezvousClient, 'rendezvous.join')).toEqual([
      {
        t: 'rendezvous.join',
        sessionId: 'session-2',
        settings: initialSettings,
      },
    ]);
  });
});

describe('RtcProvider connection retry', () => {
  it('exposes a manual retry API that recreates a failed dashboard connection immediately', async () => {
    const rendered = await renderRtcProvider({ rendezvous: null, voiceSettings: null });
    const failedClient = rtcMock.instances[0];

    await openWithLegacyFallback(failedClient);
    expect(sentOf(failedClient, 'sessions.list.subscribe')).toEqual([{ t: 'sessions.list.subscribe' }]);
    expect(sentOf(failedClient, 'sessions.catalog.request')).toEqual([{ t: 'sessions.catalog.request' }]);

    await act(async () => {
      failedClient.emitStatus('error', 'signal:network down');
    });

    expect(rendered.context().canRetryConnection).toBe(true);
    expect(rendered.context().detail).toBe('signal:network down');

    await act(async () => {
      rendered.context().retryConnection();
    });

    expect(failedClient.closed).toBe(true);
    expect(rtcMock.instances).toHaveLength(2);
    const retryClient = rtcMock.instances[1];
    expect(retryClient.hostPeerId).toBe('host-1');
    expect(retryClient.connected).toBe(true);
    expect(rendered.context().detail).toBeUndefined();

    await openWithLegacyFallback(retryClient);
    expect(sentOf(retryClient, 'sessions.list.subscribe')).toEqual([{ t: 'sessions.list.subscribe' }]);
    expect(sentOf(retryClient, 'sessions.catalog.request')).toEqual([{ t: 'sessions.catalog.request' }]);
  });

  it('automatically retries connection failures with a bounded backoff instead of a tight loop', async () => {
    vi.useFakeTimers();
    await renderRtcProvider({ rendezvous: null, voiceSettings: null });
    const failedClient = rtcMock.instances[0];

    await act(async () => {
      failedClient.emitStatus('error', 'signal:offline');
    });

    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(rtcMock.instances).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(failedClient.closed).toBe(true);
    expect(rtcMock.instances).toHaveLength(2);
    expect(rtcMock.instances[1].hostPeerId).toBe('host-1');
  });

  it('resends voice-room catalog, session, and settings messages after a manual retry opens', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept('voice-room-1');

    await openWithLegacyFallback(voiceClient);
    expect(sentOf(voiceClient, 'tts.catalog.request')).toEqual([{ t: 'tts.catalog.request' }]);
    expect(sentOf(voiceClient, 'stt.catalog.request')).toEqual([{ t: 'stt.catalog.request' }]);
    expect(sentOf(voiceClient, 'sessions.list.subscribe')).toEqual([{ t: 'sessions.list.subscribe' }]);
    expect(sentOf(voiceClient, 'sessions.catalog.request')).toEqual([{ t: 'sessions.catalog.request' }]);
    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: initialSettings },
    ]);

    await act(async () => {
      voiceClient.emitStatus('error', 'ice:failed');
    });
    await act(async () => {
      rendered.context().retryConnection();
    });

    expect(voiceClient.closed).toBe(true);
    expect(rtcMock.instances).toHaveLength(3);
    const retryVoiceClient = rtcMock.instances[2];
    expect(retryVoiceClient.hostPeerId).toBe('voice-room-1');

    await openWithLegacyFallback(retryVoiceClient);

    expect(sentOf(retryVoiceClient, 'tts.catalog.request')).toEqual([{ t: 'tts.catalog.request' }]);
    expect(sentOf(retryVoiceClient, 'stt.catalog.request')).toEqual([{ t: 'stt.catalog.request' }]);
    expect(sentOf(retryVoiceClient, 'sessions.list.subscribe')).toEqual([{ t: 'sessions.list.subscribe' }]);
    expect(sentOf(retryVoiceClient, 'sessions.catalog.request')).toEqual([{ t: 'sessions.catalog.request' }]);
    expect(sentOf(retryVoiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: initialSettings },
    ]);
  });

  it('does not recreate a healthy open connection when retryConnection is called directly', async () => {
    const rendered = await renderRtcProvider({ rendezvous: null, voiceSettings: null });
    const openClient = rtcMock.instances[0];

    await openWithLegacyFallback(openClient);
    expect(rendered.context().canRetryConnection).toBe(false);

    await act(async () => {
      rendered.context().retryConnection();
    });

    expect(openClient.closed).toBe(false);
    expect(rtcMock.instances).toHaveLength(1);
    expect(rendered.context().status).toBe('open');
  });

  it('ignores stale binary and remote-stream events from a cleaned-up retry client', async () => {
    const rendered = await renderRtcProvider({ rendezvous: null, voiceSettings: null });
    const staleClient = rtcMock.instances[0];
    const seenBinary: ArrayBuffer[] = [];
    const seenStreams: MediaStream[] = [];
    const detachBinary = rendered.context().addBinaryListener((bytes) => seenBinary.push(bytes));
    const detachStream = rendered.context().addRemoteStreamListener((stream) => seenStreams.push(stream));

    await act(async () => {
      staleClient.emitStatus('error', 'signal:network down');
    });
    await act(async () => {
      rendered.context().retryConnection();
    });

    expect(staleClient.closed).toBe(true);
    await act(async () => {
      staleClient.emitBinary(new Uint8Array([1, 2, 3]).buffer);
      staleClient.emitRemoteStream({ id: 'stale-stream' } as unknown as MediaStream);
    });

    expect(seenBinary).toEqual([]);
    expect(seenStreams).toEqual([]);

    detachBinary();
    detachStream();
  });

  it('does not retry replaced sessions automatically or manually', async () => {
    vi.useFakeTimers();
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();

    await act(async () => {
      voiceClient.emitControl({ t: 'session.replaced' });
    });

    expect(rendered.context().status).toBe('closed');
    expect(rendered.context().detail).toBe('session_replaced');
    expect(rendered.context().canRetryConnection).toBe(false);

    await act(async () => {
      rendered.context().retryConnection();
      vi.advanceTimersByTime(60_000);
    });

    expect(rtcMock.instances).toHaveLength(2);
  });

  it('does not re-enable retries when a protocol-mismatched daemon closes after daemon.unsupported', async () => {
    vi.useFakeTimers();
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();

    await act(async () => {
      voiceClient.emitControl({
        t: 'daemon.unsupported',
        minProtocol: 1,
        maxProtocol: 1,
        message: 'unsupported_daemon_protocol',
      });
    });

    expect(rendered.context().status).toBe('error');
    expect(rendered.context().detail).toBe('unsupported_daemon_protocol');
    expect(rendered.context().canRetryConnection).toBe(false);

    await act(async () => {
      voiceClient.emitStatus('closed');
    });

    expect(rendered.context().status).toBe('closed');
    expect(rendered.context().detail).toBe('unsupported_daemon_protocol');
    expect(rendered.context().canRetryConnection).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(rtcMock.instances).toHaveLength(2);
  });
});

describe('RtcProvider STT catalog and settings sync', () => {
  const sttCatalog: SttCatalog = {
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

  it('requests both TTS and STT catalogs once after the voice room opens', async () => {
    await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);
    expect(sentOf(voiceClient, 'tts.catalog.request')).toEqual([{ t: 'tts.catalog.request' }]);
    expect(sentOf(voiceClient, 'stt.catalog.request')).toEqual([{ t: 'stt.catalog.request' }]);

    await activeRender!.rerender({ voiceSettings: { ...initialSettings } });
    expect(sentOf(voiceClient, 'stt.catalog.request')).toHaveLength(1);
  });

  it('does not send manual STT catalog requests while still in the rendezvous room', async () => {
    const rendered = await renderRtcProvider();
    const rendezvousClient = rtcMock.instances[0];

    await act(async () => {
      rendered.context().requestSttCatalog?.();
    });
    expect(sentOf(rendezvousClient, 'stt.catalog.request')).toHaveLength(0);

    await openWithDaemonHello(rendezvousClient);
    await act(async () => {
      rendered.context().requestSttCatalog?.();
    });
    expect(sentOf(rendezvousClient, 'stt.catalog.request')).toHaveLength(0);
  });

  it('does not send manual STT catalog requests before the voice room opens', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();

    await act(async () => {
      rendered.context().requestSttCatalog?.();
    });

    expect(sentOf(voiceClient, 'stt.catalog.request')).toHaveLength(0);
  });

  it('lets context consumers request the STT catalog explicitly', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);

    await act(async () => {
      rendered.context().requestSttCatalog?.();
    });

    expect(sentOf(voiceClient, 'stt.catalog.request')).toHaveLength(2);
  });

  it('exposes received STT catalogs to context consumers', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await act(async () => {
      voiceClient.emitStatus('open');
      voiceClient.emitControl({ t: 'stt.catalog', catalog: sttCatalog });
    });

    expect(rendered.context().sttCatalog).toEqual(sttCatalog);
  });

  it('includes settings.stt in the initial rendezvous.join when present', async () => {
    const settings: VoiceSettings = {
      voice: 'eve',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'eve' },
      stt: { providerId: 'xai', model: 'grok-stt' },
    };
    await renderRtcProvider({ voiceSettings: settings });
    const rendezvousClient = rtcMock.instances[0];

    await openWithDaemonHello(rendezvousClient);

    const joins = sentOf(rendezvousClient, 'rendezvous.join');
    expect(joins).toHaveLength(1);
    const join = joins[0] as { settings?: VoiceSettings };
    expect(join.settings?.stt).toEqual({ providerId: 'xai', model: 'grok-stt' });
  });

  it('emits settings.update when only the STT selection changes', async () => {
    const startingSettings: VoiceSettings = {
      voice: 'eve',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'eve' },
      stt: { providerId: 'xai', model: 'grok-stt' },
    };
    await renderRtcProvider({ voiceSettings: startingSettings });
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);
    expect(sentOf(voiceClient, 'settings.update')).toHaveLength(1);

    const sttChange: VoiceSettings = {
      ...startingSettings,
      stt: { providerId: 'openai', model: 'whisper-1' },
    };
    await activeRender!.rerender({ voiceSettings: sttChange });

    expect(sentOf(voiceClient, 'settings.update')).toHaveLength(2);
    const last = sentOf(voiceClient, 'settings.update').at(-1) as {
      settings?: VoiceSettings;
    };
    expect(last.settings?.stt).toEqual({ providerId: 'openai', model: 'whisper-1' });
  });

  it('dedupes when neither TTS nor STT selection has changed', async () => {
    const startingSettings: VoiceSettings = {
      voice: 'eve',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'eve' },
      stt: { providerId: 'xai', model: 'grok-stt' },
    };
    await renderRtcProvider({ voiceSettings: startingSettings });
    const voiceClient = await openRendezvousAndAccept();
    await openWithLegacyFallback(voiceClient);
    expect(sentOf(voiceClient, 'settings.update')).toHaveLength(1);

    await activeRender!.rerender({
      voiceSettings: {
        ...startingSettings,
        tts: { ...startingSettings.tts },
        stt: { ...startingSettings.stt },
      },
    });

    expect(sentOf(voiceClient, 'settings.update')).toHaveLength(1);
  });
});

describe('App voice settings mapping', () => {
  it('includes explicit STT settings for RtcProvider', async () => {
    const { voiceSettingsForRtc } = await import('../client/src/app');

    expect(
      voiceSettingsForRtc({
        voice: 'nova',
        tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
        stt: { providerId: 'xai', model: 'grok-stt' },
        speed: 1.05,
        format: 'md',
        timestamps: false,
      }),
    ).toEqual({
      voice: 'nova',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
      stt: { providerId: 'xai', model: 'grok-stt' },
    });
  });
});
