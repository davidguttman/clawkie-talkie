// Pins the wire shape of the PeerJS DataConnection messages between the
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
} from '../daemon/src/protocol';

describe('phone → daemon factories', () => {
  it('emits stable `t` tags', () => {
    expect(phoneClient.sttStart()).toEqual({ t: 'stt.start' });
    expect(phoneClient.sttAudioDone()).toEqual({ t: 'stt.audio.done' });
    expect(phoneClient.sttCancel()).toEqual({ t: 'stt.cancel' });
    expect(phoneClient.replyCancel()).toEqual({ t: 'reply.cancel' });
  });

  it('matches the daemon copy of the protocol', () => {
    expect(phoneClient.sttStart()).toEqual(phoneDaemon.sttStart());
    expect(phoneClient.sttAudioDone()).toEqual(phoneDaemon.sttAudioDone());
    expect(phoneClient.sttCancel()).toEqual(phoneDaemon.sttCancel());
    expect(phoneClient.replyCancel()).toEqual(phoneDaemon.replyCancel());
  });
});

describe('daemon → phone factories', () => {
  it('emits stable `t` tags + payloads', () => {
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

  it('matches the daemon copy of the protocol', () => {
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
