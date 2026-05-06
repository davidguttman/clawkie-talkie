// Pins the wire shape of the WebRTC DataChannel messages between the
// phone and daemon. The client and daemon each have their own copy of
// the protocol factories (no shared workspace); these tests make sure
// the two stay in agreement on the serialized form.

import { describe, it, expect } from 'vitest';
import {
  phoneToDaemon as phoneClient,
  daemonToPhone as daemonClient,
} from '../client/src/voice/protocol';
import {
  phoneToDaemon as phoneDaemon,
  daemonToPhone as daemonDaemon,
  validateRendezvousDelivery,
} from '../daemon/src/protocol';

describe('phone → daemon factories', () => {
  it('emits stable `t` tags', () => {
    expect(phoneClient.sttStart()).toEqual({ t: 'stt.start' });
    expect(phoneClient.sttAudioDone()).toEqual({ t: 'stt.audio.done' });
    expect(phoneClient.sttCancel()).toEqual({ t: 'stt.cancel' });
    expect(phoneClient.replyCancel()).toEqual({ t: 'reply.cancel' });
  });

  it('emits a session-only rendezvous join without delivery', () => {
    expect(phoneClient.rendezvousJoin({ sessionId: 'session-1' })).toEqual({
      t: 'rendezvous.join',
      sessionId: 'session-1',
    });
    expect(phoneClient.rendezvousJoin({ sessionId: 'session-1' })).toEqual(
      phoneDaemon.rendezvousJoin({ sessionId: 'session-1' }),
    );
  });

  it('includes sessionKey, channel, target, and accountId routing metadata in rendezvous join without changing session identity', () => {
    expect(
      phoneClient.rendezvousJoin({
        sessionId: 'session-uuid',
        sessionKey: 'agent:main:discord:channel:thread-1',
        channel: 'discord',
        target: 'channel:thread-1',
        accountId: 'acct-1',
      }),
    ).toEqual({
      t: 'rendezvous.join',
      sessionId: 'session-uuid',
      sessionKey: 'agent:main:discord:channel:thread-1',
      channel: 'discord',
      target: 'channel:thread-1',
      accountId: 'acct-1',
    });
    expect(
      phoneClient.rendezvousJoin({
        sessionId: 'session-uuid',
        sessionKey: 'agent:main:discord:channel:thread-1',
        channel: 'discord',
        target: 'channel:thread-1',
        accountId: 'acct-1',
      }),
    ).toEqual(
      phoneDaemon.rendezvousJoin({
        sessionId: 'session-uuid',
        sessionKey: 'agent:main:discord:channel:thread-1',
        channel: 'discord',
        target: 'channel:thread-1',
        accountId: 'acct-1',
      }),
    );
  });

  it('includes voice settings in rendezvous join when provided', () => {
    expect(
      phoneClient.rendezvousJoin({
        sessionId: 'session-1',
        settings: { voice: 'ara' },
      }),
    ).toEqual({
      t: 'rendezvous.join',
      sessionId: 'session-1',
      settings: { voice: 'ara' },
    });
  });

  it('emits settings.update for voice changes mid-session', () => {
    expect(phoneClient.settingsUpdate({ voice: 'rex' })).toEqual({
      t: 'settings.update',
      settings: { voice: 'rex' },
    });
    expect(phoneClient.settingsUpdate({ voice: 'rex' })).toEqual(
      phoneDaemon.settingsUpdate({ voice: 'rex' }),
    );
  });

  it('requests the daemon TTS catalog', () => {
    expect(phoneClient.ttsCatalogRequest()).toEqual({ t: 'tts.catalog.request' });
    expect(phoneDaemon.ttsCatalogRequest()).toEqual({ t: 'tts.catalog.request' });
  });

  it('requests the daemon STT catalog', () => {
    expect(phoneClient.sttCatalogRequest()).toEqual({ t: 'stt.catalog.request' });
    expect(phoneDaemon.sttCatalogRequest()).toEqual({ t: 'stt.catalog.request' });
  });

  it('requests and subscribes to the daemon recent session list', () => {
    expect(phoneClient.sessionsListRequest()).toEqual({ t: 'sessions.list.request' });
    expect(phoneClient.sessionsListSubscribe()).toEqual({ t: 'sessions.list.subscribe' });
    expect(phoneClient.sessionsListUnsubscribe()).toEqual({ t: 'sessions.list.unsubscribe' });
    expect(phoneClient.sessionsCatalogRequest()).toEqual({ t: 'sessions.catalog.request' });
    expect(phoneDaemon.sessionsCatalogRequest()).toEqual({ t: 'sessions.catalog.request' });
    expect(phoneClient.sessionsListRequest()).toEqual(phoneDaemon.sessionsListRequest());
    expect(phoneClient.sessionsListSubscribe()).toEqual(phoneDaemon.sessionsListSubscribe());
    expect(phoneClient.sessionsListUnsubscribe()).toEqual(phoneDaemon.sessionsListUnsubscribe());
    expect(phoneClient.sessionsCatalogRequest()).toEqual(phoneDaemon.sessionsCatalogRequest());
  });

  it('includes canonical STT selection in settings.update', () => {
    const stt = { providerId: 'xai', model: 'grok-stt' };
    expect(phoneClient.settingsUpdate({ stt })).toEqual({
      t: 'settings.update',
      settings: { stt },
    });
    expect(phoneClient.settingsUpdate({ stt })).toEqual(phoneDaemon.settingsUpdate({ stt }));
  });

  it('includes canonical TTS selection in settings.update while preserving legacy voice', () => {
    const selection = { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' };
    expect(phoneClient.settingsUpdate({ voice: 'nova', tts: selection })).toEqual({
      t: 'settings.update',
      settings: { voice: 'nova', tts: selection },
    });
    expect(phoneClient.settingsUpdate({ voice: 'nova', tts: selection })).toEqual(
      phoneDaemon.settingsUpdate({ voice: 'nova', tts: selection }),
    );
  });

  it('matches the daemon copy of the protocol', () => {
    expect(phoneClient.sttStart()).toEqual(phoneDaemon.sttStart());
    expect(phoneClient.sttAudioDone()).toEqual(phoneDaemon.sttAudioDone());
    expect(phoneClient.sttCancel()).toEqual(phoneDaemon.sttCancel());
    expect(phoneClient.replyCancel()).toEqual(phoneDaemon.replyCancel());
    expect(
      phoneClient.rendezvousJoin({
        sessionId: 's',
      }),
    ).toEqual(
      phoneDaemon.rendezvousJoin({
        sessionId: 's',
      }),
    );
  });
});


describe('rendezvous delivery validation', () => {
  it('accepts absent delivery as session-only', () => {
    expect(validateRendezvousDelivery(undefined)).toEqual({ ok: true });
  });

  it('ignores legacy nested delivery values instead of blocking the session-bound agent turn', () => {
    expect(validateRendezvousDelivery({ channel: ' discord ', target: ' channel:t ', accountId: ' acct ' })).toEqual({ ok: true });
    expect(validateRendezvousDelivery({ channel: 'webchat' })).toEqual({ ok: true });
    expect(validateRendezvousDelivery({ channel: 'discord' })).toEqual({ ok: true });
    expect(validateRendezvousDelivery({ target: 'channel:t' })).toEqual({ ok: true });
  });
});


describe('daemon → phone factories', () => {
  it('emits stable `t` tags + payloads', () => {
    expect(daemonClient.rendezvousAccept('host-1:session-1')).toEqual({
      t: 'rendezvous.accept',
      roomId: 'host-1:session-1',
    });
    expect(daemonClient.rendezvousError('missing_session')).toEqual({
      t: 'rendezvous.error',
      message: 'missing_session',
    });
    expect(daemonClient.sessionReplaced()).toEqual({
      t: 'session.replaced',
      reason: 'newer_phone_connected',
    });
    expect(daemonClient.sttReady()).toEqual({ t: 'stt.ready' });
    expect(daemonClient.sttPartial('he', false)).toEqual({
      t: 'stt.partial',
      text: 'he',
      is_final: false,
    });
    expect(daemonClient.sttPartial('hello', true)).toEqual({
      t: 'stt.partial',
      text: 'hello',
      is_final: true,
    });
    expect(daemonClient.sttDone('hello there')).toEqual({
      t: 'stt.done',
      text: 'hello there',
    });
    expect(daemonClient.sttError('boom')).toEqual({ t: 'stt.error', message: 'boom' });
    expect(daemonClient.sttClosed()).toEqual({ t: 'stt.closed' });
    expect(daemonClient.replyStart('u')).toEqual({ t: 'reply.start', text: 'u' });
    expect(daemonClient.replyDone('a')).toEqual({ t: 'reply.done', text: 'a' });
    expect(daemonClient.replyError('r')).toEqual({ t: 'reply.error', message: 'r' });
    expect(daemonClient.ttsStart(24000)).toEqual({ t: 'tts.start', sample_rate: 24000 });
    expect(daemonClient.ttsDone()).toEqual({ t: 'tts.done' });
    expect(daemonClient.ttsError('nope')).toEqual({ t: 'tts.error', message: 'nope' });
  });

  it('emits STT catalog payloads', () => {
    const catalog = {
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
    expect(daemonClient.sttCatalog(catalog)).toEqual({ t: 'stt.catalog', catalog });
    expect(daemonClient.sttCatalog(catalog)).toEqual(daemonDaemon.sttCatalog(catalog));
  });

  it('emits recent session-list payloads', () => {
    const snapshot = {
      generatedAt: '2026-05-05T19:00:00.000Z',
      sessions: [
        {
          sessionId: 'session-uuid',
          sessionKey: 'agent:kamaji:discord:channel:thread-1',
          agent: 'kamaji',
          channel: 'discord',
          target: 'channel:thread-1',
          lastActivity: '2026-05-05T18:59:00.000Z',
          displayLabel: 'Thread name',
        },
      ],
    };
    expect(daemonClient.sessionsList(snapshot)).toEqual({
      t: 'sessions.list',
      generatedAt: snapshot.generatedAt,
      sessions: snapshot.sessions,
    });
    expect(daemonClient.sessionsList(snapshot)).toEqual(daemonDaemon.sessionsList(snapshot));
    expect(daemonClient.sessionsCatalog(snapshot)).toEqual({
      t: 'sessions.catalog',
      catalog: snapshot,
    });
  });

  it('emits TTS catalog payloads', () => {
    const catalog = {
      activeProvider: 'openai',
      generatedAt: '2026-04-29T00:00:00.000Z',
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          configured: true,
          selected: true,
          available: true,
          models: ['gpt-4o-mini-tts'],
          voices: [{ id: 'nova', name: 'nova' }],
        },
      ],
    };
    expect(daemonClient.ttsCatalog(catalog)).toEqual({ t: 'tts.catalog', catalog });
    expect(daemonClient.ttsCatalog(catalog)).toEqual(daemonDaemon.ttsCatalog(catalog));
  });


  it('emits reconnect catch-up snapshots with bounded event records', () => {
    const turn = {
      inFlight: false,
      phase: 'complete' as const,
      latestEventId: 3,
      userText: 'hello',
      replyText: 'spoken reply',
    };
    const events = [
      { id: 2, msg: daemonClient.replyDone('spoken reply') },
      { id: 3, msg: daemonClient.ttsDone() },
    ];
    expect(daemonClient.sessionSnapshot({ roomId: 'host:s1', latestEventId: 3, disconnectedMs: 31_000, turn, events })).toEqual({
      t: 'session.snapshot',
      roomId: 'host:s1',
      latestEventId: 3,
      disconnectedMs: 31_000,
      turn,
      events,
    });
    expect(daemonClient.sessionSnapshot({ roomId: 'host:s1', latestEventId: 3, turn, events })).toEqual(
      daemonDaemon.sessionSnapshot({ roomId: 'host:s1', latestEventId: 3, turn, events }),
    );
  });

  it('matches the daemon copy of the protocol', () => {
    expect(daemonClient.rendezvousAccept('r')).toEqual(daemonDaemon.rendezvousAccept('r'));
    expect(daemonClient.rendezvousError('m')).toEqual(daemonDaemon.rendezvousError('m'));
    expect(daemonClient.sessionReplaced()).toEqual(daemonDaemon.sessionReplaced());
    expect(daemonClient.sttReady()).toEqual(daemonDaemon.sttReady());
    expect(daemonClient.sttPartial('x', true)).toEqual(daemonDaemon.sttPartial('x', true));
    expect(daemonClient.sttDone('y')).toEqual(daemonDaemon.sttDone('y'));
    expect(daemonClient.sttError('z')).toEqual(daemonDaemon.sttError('z'));
    expect(daemonClient.sttClosed()).toEqual(daemonDaemon.sttClosed());
    expect(daemonClient.replyStart('u')).toEqual(daemonDaemon.replyStart('u'));
    expect(daemonClient.replyDone('a')).toEqual(daemonDaemon.replyDone('a'));
    expect(daemonClient.replyError('r')).toEqual(daemonDaemon.replyError('r'));
    expect(daemonClient.ttsStart(24000)).toEqual(daemonDaemon.ttsStart(24000));
    expect(daemonClient.ttsDone()).toEqual(daemonDaemon.ttsDone());
    expect(daemonClient.ttsError('n')).toEqual(daemonDaemon.ttsError('n'));
  });

  it('round-trips through JSON', () => {
    const messages = [
      daemonClient.rendezvousAccept('host:s1'),
      daemonClient.rendezvousError('bad'),
      daemonClient.sessionReplaced(),
      daemonClient.sttReady(),
      daemonClient.sttPartial('hello', false),
      daemonClient.sttDone('hello world'),
      daemonClient.replyStart('hello world'),
      daemonClient.replyDone('hi there'),
      daemonClient.ttsStart(24000),
      daemonClient.ttsDone(),
      daemonClient.ttsError('x'),
    ];
    for (const m of messages) {
      const roundtrip = JSON.parse(JSON.stringify(m));
      expect(roundtrip).toEqual(m);
    }
  });
});
