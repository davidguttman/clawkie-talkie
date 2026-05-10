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

function makeJoin(sessionId: string) {
  return JSON.stringify({
    t: 'rendezvous.join',
    sessionId,
    delivery: { channel: 'discord', target: `channel:${sessionId}` },
  });
}

function makeManagedVoiceSession(options: {
  lastUsedAtMs: number;
  canEvictForVoiceSessionLimit?: boolean;
}) {
  const session = {
    applyVoiceSettings: vi.fn(() => session.touchActivity()),
    close: vi.fn(),
    touchActivity: vi.fn(),
    lastUsedAtMs: options.lastUsedAtMs,
    canEvictForVoiceSessionLimit: options.canEvictForVoiceSessionLimit ?? true,
  };
  return session;
}

describe('DaemonPeer rendezvous capability handshake', () => {
  it('answers client hello on the host rendezvous lane before join without opening a voice room', async () => {
    const { DaemonPeer } = await import('../daemon/src/peer');
    const peer = new DaemonPeer({
      peerId: 'host-1',
      signalServer: 'https://signal.example',
      iceServers: [],
      onReady: vi.fn(),
    });
    const rendezvousPeer = makeRendezvousPeer();
    const roomId = makeVoiceRoomId({ hostPeerId: 'host-1', sessionId: 'session-1' });

    (peer as unknown as {
      handleRendezvousData(rp: unknown, data: unknown): void;
    }).handleRendezvousData(
      rendezvousPeer,
      JSON.stringify({ t: 'client.hello', protocol: 1, wants: ['tts.catalog'] }),
    );

    expect(rendezvousPeer.peer.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        t: 'daemon.hello',
        protocol: 1,
        features: ['tts.catalog', 'stt.catalog', 'sessions.list', 'sessions.catalog'],
      }),
    );
    expect((peer as unknown as { activeRoomIds: string[] }).activeRoomIds).toEqual([]);

    (peer as unknown as {
      handleRendezvousData(rp: unknown, data: unknown): void;
    }).handleRendezvousData(
      rendezvousPeer,
      JSON.stringify({ t: 'rendezvous.join', sessionId: 'session-1' }),
    );

    expect(rendezvousPeer.peer.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ t: 'rendezvous.accept', roomId }),
    );

    clearTimeout(rendezvousPeer.timeout);
    peer.close();
  });

  it('returns daemon unsupported for protocols outside daemon support bounds without joining', async () => {
    const { DaemonPeer } = await import('../daemon/src/peer');
    const peer = new DaemonPeer({
      peerId: 'host-1',
      signalServer: 'https://signal.example',
      iceServers: [],
      onReady: vi.fn(),
    });
    const rendezvousPeer = makeRendezvousPeer();

    expect(() => {
      (peer as unknown as {
        handleRendezvousData(rp: unknown, data: unknown): void;
      }).handleRendezvousData(
        rendezvousPeer,
        JSON.stringify({ t: 'client.hello', protocol: 2, wants: [] }),
      );
    }).not.toThrow();

    expect(rendezvousPeer.peer.send).toHaveBeenCalledWith(
      JSON.stringify({
        t: 'daemon.unsupported',
        minProtocol: 1,
        maxProtocol: 1,
        message: 'unsupported_daemon_protocol',
      }),
    );
    expect((peer as unknown as { activeRoomIds: string[] }).activeRoomIds).toEqual([]);

    (peer as unknown as {
      handleRendezvousData(rp: unknown, data: unknown): void;
    }).handleRendezvousData(
      rendezvousPeer,
      JSON.stringify({ t: 'rendezvous.join', sessionId: 'session-1' }),
    );

    expect(rendezvousPeer.peer.send).not.toHaveBeenCalledWith(
      JSON.stringify({
        t: 'rendezvous.accept',
        roomId: makeVoiceRoomId({ hostPeerId: 'host-1', sessionId: 'session-1' }),
      }),
    );
    expect((peer as unknown as { activeRoomIds: string[] }).activeRoomIds).toEqual([]);

    clearTimeout(rendezvousPeer.timeout);
    peer.close();
  });

  it('does not answer repeated client hello after rendezvous protocol is unsupported', async () => {
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
      JSON.stringify({ t: 'client.hello', protocol: 2, wants: [] }),
    );
    (peer as unknown as {
      handleRendezvousData(rp: unknown, data: unknown): void;
    }).handleRendezvousData(
      rendezvousPeer,
      JSON.stringify({ t: 'client.hello', protocol: 1, wants: ['tts.catalog'] }),
    );
    (peer as unknown as {
      handleRendezvousData(rp: unknown, data: unknown): void;
    }).handleRendezvousData(
      rendezvousPeer,
      JSON.stringify({ t: 'rendezvous.join', sessionId: 'session-1' }),
    );

    expect(rendezvousPeer.peer.send).toHaveBeenCalledTimes(1);
    expect(rendezvousPeer.peer.send).toHaveBeenCalledWith(
      JSON.stringify({
        t: 'daemon.unsupported',
        minProtocol: 1,
        maxProtocol: 1,
        message: 'unsupported_daemon_protocol',
      }),
    );
    expect((peer as unknown as { activeRoomIds: string[] }).activeRoomIds).toEqual([]);

    clearTimeout(rendezvousPeer.timeout);
    peer.close();
  });
});

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
      touchActivity: vi.fn(),
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


  it('evicts the least-recently-used idle voice session when the session limit is full', async () => {
    const { DaemonPeer } = await import('../daemon/src/peer');
    const peer = new DaemonPeer({
      peerId: 'host-1',
      signalServer: 'https://signal.example',
      iceServers: [],
      maxVoiceSessions: 2,
      onReady: vi.fn(),
    });
    const olderRoomId = makeVoiceRoomId({ hostPeerId: 'host-1', sessionId: 'session-older' });
    const newerRoomId = makeVoiceRoomId({ hostPeerId: 'host-1', sessionId: 'session-newer' });
    const incomingRoomId = makeVoiceRoomId({ hostPeerId: 'host-1', sessionId: 'session-incoming' });
    const older = makeManagedVoiceSession({ lastUsedAtMs: 10 });
    const newer = makeManagedVoiceSession({ lastUsedAtMs: 20 });
    const sessions = (peer as unknown as { voiceSessions: Map<string, unknown> }).voiceSessions;
    sessions.set(olderRoomId, older);
    sessions.set(newerRoomId, newer);
    const rendezvousPeer = makeRendezvousPeer();

    (peer as unknown as {
      handleRendezvousData(rp: unknown, data: unknown): void;
    }).handleRendezvousData(rendezvousPeer, makeJoin('session-incoming'));

    expect(older.close).toHaveBeenCalledTimes(1);
    expect(newer.close).not.toHaveBeenCalled();
    expect((peer as unknown as { activeRoomIds: string[] }).activeRoomIds).toEqual([
      newerRoomId,
      incomingRoomId,
    ]);
    expect(rendezvousPeer.peer.send).toHaveBeenCalledWith(
      JSON.stringify({ t: 'rendezvous.accept', roomId: incomingRoomId }),
    );

    clearTimeout(rendezvousPeer.timeout);
    peer.close();
  });

  it('does not evict when the incoming session already maps to an existing room at the limit', async () => {
    const { DaemonPeer } = await import('../daemon/src/peer');
    const peer = new DaemonPeer({
      peerId: 'host-1',
      signalServer: 'https://signal.example',
      iceServers: [],
      maxVoiceSessions: 2,
      onReady: vi.fn(),
    });
    const existingRoomId = makeVoiceRoomId({ hostPeerId: 'host-1', sessionId: 'session-existing' });
    const otherRoomId = makeVoiceRoomId({ hostPeerId: 'host-1', sessionId: 'session-other' });
    const existing = makeManagedVoiceSession({ lastUsedAtMs: 10 });
    const other = makeManagedVoiceSession({ lastUsedAtMs: 20 });
    const sessions = (peer as unknown as { voiceSessions: Map<string, unknown> }).voiceSessions;
    sessions.set(existingRoomId, existing);
    sessions.set(otherRoomId, other);
    const rendezvousPeer = makeRendezvousPeer();

    (peer as unknown as {
      handleRendezvousData(rp: unknown, data: unknown): void;
    }).handleRendezvousData(rendezvousPeer, makeJoin('session-existing'));

    expect(existing.close).not.toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
    expect(existing.applyVoiceSettings).toHaveBeenCalledWith({});
    expect(existing.touchActivity).toHaveBeenCalled();
    expect((peer as unknown as { activeRoomIds: string[] }).activeRoomIds).toEqual([
      existingRoomId,
      otherRoomId,
    ]);
    expect(rendezvousPeer.peer.send).toHaveBeenCalledWith(
      JSON.stringify({ t: 'rendezvous.accept', roomId: existingRoomId }),
    );

    clearTimeout(rendezvousPeer.timeout);
    peer.close();
  });

  it('returns too_many_voice_sessions when every room is active or in flight', async () => {
    const { DaemonPeer } = await import('../daemon/src/peer');
    const peer = new DaemonPeer({
      peerId: 'host-1',
      signalServer: 'https://signal.example',
      iceServers: [],
      maxVoiceSessions: 2,
      onReady: vi.fn(),
    });
    const activeRoomId = makeVoiceRoomId({ hostPeerId: 'host-1', sessionId: 'session-active' });
    const inFlightRoomId = makeVoiceRoomId({ hostPeerId: 'host-1', sessionId: 'session-in-flight' });
    const active = makeManagedVoiceSession({ lastUsedAtMs: 10, canEvictForVoiceSessionLimit: false });
    const inFlight = makeManagedVoiceSession({ lastUsedAtMs: 20, canEvictForVoiceSessionLimit: false });
    const sessions = (peer as unknown as { voiceSessions: Map<string, unknown> }).voiceSessions;
    sessions.set(activeRoomId, active);
    sessions.set(inFlightRoomId, inFlight);
    const rendezvousPeer = makeRendezvousPeer();

    (peer as unknown as {
      handleRendezvousData(rp: unknown, data: unknown): void;
    }).handleRendezvousData(rendezvousPeer, makeJoin('session-incoming'));

    expect(active.close).not.toHaveBeenCalled();
    expect(inFlight.close).not.toHaveBeenCalled();
    expect((peer as unknown as { activeRoomIds: string[] }).activeRoomIds).toEqual([
      activeRoomId,
      inFlightRoomId,
    ]);
    expect(rendezvousPeer.peer.send).toHaveBeenCalledWith(
      JSON.stringify({ t: 'rendezvous.error', message: 'too_many_voice_sessions' }),
    );

    clearTimeout(rendezvousPeer.timeout);
    peer.close();
  });

});
