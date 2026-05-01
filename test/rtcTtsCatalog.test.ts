import { act, createElement, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlMessage, RtcClientOptions, RtcStatus } from '../client/src/rtc/client';
import type { RtcContextValue, RtcRendezvous } from '../client/src/rtc/RtcContext';
import type { SttCatalog, TtsCatalog, VoiceSettings } from '../client/src/voice/protocol';

interface FakeRtcClientInstance {
  hostPeerId: string;
  sent: ControlMessage[];
  connected: boolean;
  closed: boolean;
  sendControl(msg: ControlMessage): void;
  sendBinary(bytes: ArrayBuffer | Uint8Array): void;
  connect(): void;
  close(): void;
  emitStatus(status: RtcStatus, detail?: string): void;
  emitControl(msg: ControlMessage): void;
}

const rtcMock = vi.hoisted(() => ({
  instances: [] as FakeRtcClientInstance[],
}));

vi.mock('../client/src/rtc/client', () => {
  class FakeRtcClient implements FakeRtcClientInstance {
    hostPeerId: string;
    sent: ControlMessage[] = [];
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

    sendBinary(_bytes: ArrayBuffer | Uint8Array): void {
      // not needed for these tests
    }

    emitStatus(status: RtcStatus, detail?: string): void {
      this.opts.onStatusChange?.(status, detail);
    }

    emitControl(msg: ControlMessage): void {
      this.opts.onControlMessage?.(msg);
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

afterEach(async () => {
  if (activeRender) await activeRender.unmount();
  activeRender = null;
  rtcMock.instances.length = 0;
  vi.clearAllMocks();
});

describe('RtcProvider TTS catalog and settings sync', () => {
  it('omits provider, model, and voice hints from initial rendezvous.join for Default settings', async () => {
    await renderRtcProvider({ voiceSettings: { voice: '', tts: {}, stt: {} } });
    const rendezvousClient = rtcMock.instances[0];

    await act(async () => {
      rendezvousClient.emitStatus('open');
    });

    expect(sentOf(rendezvousClient, 'rendezvous.join')).toEqual([
      {
        t: 'rendezvous.join',
        sessionId: 'session-1',
      },
    ]);
  });

  it('requests the TTS catalog once after the voice room opens', async () => {
    await renderRtcProvider();
    const rendezvousClient = rtcMock.instances[0];

    await act(async () => {
      rendezvousClient.emitStatus('open');
    });
    expect(sentOf(rendezvousClient, 'tts.catalog.request')).toHaveLength(0);

    await act(async () => {
      rendezvousClient.emitControl({ t: 'rendezvous.accept', roomId: 'voice-room-1' });
    });
    const voiceClient = rtcMock.instances[1];
    expect(sentOf(voiceClient, 'tts.catalog.request')).toHaveLength(0);

    await act(async () => {
      voiceClient.emitStatus('open');
    });
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

  it('lets context consumers request the TTS catalog explicitly', async () => {
    const rendered = await renderRtcProvider();
    const voiceClient = await openRendezvousAndAccept();
    await act(async () => {
      voiceClient.emitStatus('open');
    });

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
    await act(async () => {
      voiceClient.emitStatus('open');
    });
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
    await act(async () => {
      voiceClient.emitStatus('open');
    });
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
    await act(async () => {
      voiceClient.emitStatus('open');
    });
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
    await act(async () => {
      voiceClient.emitStatus('open');
    });
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
    await act(async () => {
      voiceClient.emitStatus('open');
    });
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

    await act(async () => {
      rendezvousClient.emitStatus('open');
    });
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
    await act(async () => {
      voiceClient.emitStatus('open');
    });

    expect(sentOf(voiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: {} },
    ]);
  });

  it('resets settings dedupe after returning to a rendezvous room', async () => {
    await renderRtcProvider();
    const firstVoiceClient = await openRendezvousAndAccept('voice-room-1');
    await act(async () => {
      firstVoiceClient.emitStatus('open');
    });
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
    await act(async () => {
      secondVoiceClient.emitStatus('open');
    });

    expect(sentOf(secondVoiceClient, 'settings.update')).toEqual([
      { t: 'settings.update', settings: initialSettings },
    ]);
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
    await act(async () => {
      voiceClient.emitStatus('open');
    });
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

    await act(async () => {
      rendezvousClient.emitStatus('open');
    });
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
    await act(async () => {
      voiceClient.emitStatus('open');
    });

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

    await act(async () => {
      rendezvousClient.emitStatus('open');
    });

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
    await act(async () => {
      voiceClient.emitStatus('open');
    });
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
    await act(async () => {
      voiceClient.emitStatus('open');
    });
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
