import { describe, expect, it, vi } from 'vitest';
import { makeVoiceRoomId } from '../daemon/src/voiceRoom';

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
  };
}

describe('DaemonPeer rendezvous voice settings', () => {
  it('clears existing same-session settings when a reconnecting Default client omits settings', async () => {
    const { DaemonPeer } = await import('../daemon/src/peer');
    const peer = new DaemonPeer({
      peerId: 'host-1',
      signalServer: 'https://signal.example',
      iceServers: [],
      onReady: vi.fn(),
    });
    const roomId = makeVoiceRoomId({ hostPeerId: 'host-1', sessionId: 'session-1' });
    const applyVoiceSettings = vi.fn();
    (peer as unknown as { voiceSessions: Map<string, unknown> }).voiceSessions.set(roomId, {
      applyVoiceSettings,
    });
    const rendezvousPeer = makeRendezvousPeer();

    (peer as unknown as {
      handleRendezvousData(rp: unknown, data: unknown): void;
    }).handleRendezvousData(
      rendezvousPeer,
      JSON.stringify({
        t: 'rendezvous.join',
        sessionId: 'session-1',
        delivery: { channel: 'discord', target: 'channel:thread-1' },
      }),
    );

    expect(applyVoiceSettings).toHaveBeenCalledWith({});
    expect(rendezvousPeer.peer.send).toHaveBeenCalledWith(
      JSON.stringify({ t: 'rendezvous.accept', roomId }),
    );

    clearTimeout(rendezvousPeer.timeout);
    peer.close();
  });

  it('serves recent sessions on the host-only rendezvous lane before join', async () => {
    const { DaemonPeer } = await import('../daemon/src/peer');
    const snapshot = {
      generatedAt: 'recent-time',
      sessions: [
        {
          sessionId: 'session-1',
          sessionKey: 'agent:kamaji:main',
          agent: 'kamaji',
          displayLabel: 'Main chat',
        },
      ],
    };
    const peer = new DaemonPeer({
      peerId: 'host-1',
      signalServer: 'https://signal.example',
      iceServers: [],
      recentSessionsProvider: vi.fn(async () => snapshot),
      onReady: vi.fn(),
    });
    const rendezvousPeer = makeRendezvousPeer();

    (peer as unknown as {
      handleRendezvousData(rp: unknown, data: unknown): void;
    }).handleRendezvousData(
      rendezvousPeer,
      JSON.stringify({ t: 'sessions.list.request' }),
    );

    await vi.waitFor(() => {
      expect(rendezvousPeer.peer.send).toHaveBeenCalledWith(
        JSON.stringify({ t: 'sessions.list', ...snapshot }),
      );
    });

    expect((peer as unknown as { activeRoomIds: string[] }).activeRoomIds).toEqual([]);
    clearTimeout(rendezvousPeer.timeout);
    peer.close();
  });

  it('keeps unexpected rendezvous-lane messages failing safely', async () => {
    const { DaemonPeer } = await import('../daemon/src/peer');
    const peer = new DaemonPeer({
      peerId: 'host-1',
      signalServer: 'https://signal.example',
      iceServers: [],
      onReady: vi.fn(),
    });
    const rendezvousPeer = makeRendezvousPeer();

    (peer as unknown as {
      handleRendezvousData(rp: unknown, data: unknown): void;
    }).handleRendezvousData(
      rendezvousPeer,
      JSON.stringify({ t: 'tts.catalog.request' }),
    );

    expect(rendezvousPeer.peer.send).toHaveBeenCalledWith(
      JSON.stringify({ t: 'rendezvous.error', message: 'unexpected_message' }),
    );

    clearTimeout(rendezvousPeer.timeout);
    peer.close();
  });

});
