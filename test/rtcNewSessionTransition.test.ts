// Regression: creating a session from the host dashboard must hand the
// connection over to the new voice room. The App reacts to
// `sessions.created` from INSIDE an RTC control listener (Dashboard ->
// onSelectSession -> setState), so the rendezvous prop flips while the
// host/dashboard lane is already open and hello-negotiated. The provider
// must send rendezvous.join on that live lane (exactly once) and switch
// to the room from rendezvous.accept.
import { act, createElement, useState } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlMessage, RtcClientOptions, RtcStatus } from '../client/src/rtc/client';
import { PROTOCOL_FEATURES } from '../client/src/voice/protocol';

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

    sendBinary(): void {}

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

const ALL_PROTOCOL_FEATURES = Object.values(PROTOCOL_FEATURES);

afterEach(() => {
  rtcMock.instances.length = 0;
  vi.clearAllMocks();
  vi.useRealTimers();
});

function sentOf(client: FakeRtcClientInstance, type: string): ControlMessage[] {
  return client.sent.filter((msg) => msg.t === type);
}

describe('RtcProvider dashboard new-session handoff', () => {
  it('joins and switches rooms when the created session is selected from a control listener', async () => {
    installMinimalDom();
    const { createRoot } = await import('react-dom/client');
    const { RtcProvider, useRtc } = await import('../client/src/rtc/RtcContext');
    const { useEffect } = await import('react');

    let selectCalls = 0;

    // Stand-in for DashboardScreen's NewSessionFlow: selects the created
    // session from inside the provider's control-listener callback.
    function DashboardLike({ onSelect }: { onSelect: (sessionId: string) => void }) {
      const rtc = useRtc();
      useEffect(() => {
        return rtc.addControlListener((msg) => {
          if (msg.t === 'sessions.created' && typeof msg.sessionId === 'string') {
            selectCalls += 1;
            onSelect(msg.sessionId);
          }
        });
      }, [rtc.addControlListener, onSelect]);
      return null;
    }

    // Stand-in for App: selection swaps the dashboard for the rendezvous
    // prop on the already-mounted provider.
    function AppLike() {
      const [handoff, setHandoff] = useState<{ sessionId: string } | null>(null);
      return createElement(
        RtcProvider,
        {
          hostPeerId: 'host-1',
          rendezvous: handoff ? { sessionId: handoff.sessionId } : null,
          voiceSettings: null,
          children: handoff
            ? null
            : createElement(DashboardLike, { onSelect: (sessionId: string) => setHandoff({ sessionId }) }),
        } as never,
      );
    }

    const container = document.createElement('div');
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(AppLike));
    });

    const dashboardClient = rtcMock.instances[0];
    await act(async () => {
      dashboardClient.emitStatus('open');
    });
    await act(async () => {
      dashboardClient.emitControl({ t: 'daemon.hello', protocol: 1, features: ALL_PROTOCOL_FEATURES });
    });
    expect(sentOf(dashboardClient, 'rendezvous.join')).toEqual([]);

    await act(async () => {
      dashboardClient.emitControl({ t: 'sessions.created', sessionId: 'session-created-1' });
    });

    expect(selectCalls).toBe(1);
    expect(sentOf(dashboardClient, 'rendezvous.join')).toEqual([
      { t: 'rendezvous.join', sessionId: 'session-created-1' },
    ]);

    await act(async () => {
      dashboardClient.emitControl({ t: 'rendezvous.accept', roomId: 'voice-room-created' });
    });

    const voiceClient = rtcMock.instances.at(-1)!;
    expect(voiceClient).not.toBe(dashboardClient);
    expect(voiceClient.hostPeerId).toBe('voice-room-created');
    expect(voiceClient.connected).toBe(true);
    expect(dashboardClient.closed).toBe(true);
    // The dashboard lane sent exactly one join overall.
    expect(sentOf(dashboardClient, 'rendezvous.join')).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
  });
});
