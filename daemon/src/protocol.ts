// Wire protocol for the WebRTC DataChannel between the phone and
// daemon. Mirror of `client/src/voice/protocol.ts`; the protocol test
// pins both copies to the same serialized shape.
//
// Routing (sessionId, delivery channel/target) is bound once at
// rendezvous when the per-session voice room is created. `stt.start`
// no longer carries routing per turn.

export interface DeliveryTarget {
  channel: string;
  target: string;
}

export type PhoneToDaemon =
  | { t: 'rendezvous.join'; sessionId: string; delivery: DeliveryTarget }
  | { t: 'stt.start' }
  | { t: 'stt.audio.done' }
  | { t: 'stt.cancel' }
  | { t: 'reply.cancel' };

export type DaemonToPhone =
  | { t: 'rendezvous.accept'; roomId: string }
  | { t: 'rendezvous.error'; message: string }
  | { t: 'stt.ready' }
  | { t: 'stt.partial'; text: string; is_final: boolean }
  | { t: 'stt.done'; text: string }
  | { t: 'stt.error'; message: string }
  | { t: 'stt.closed' }
  | { t: 'reply.start'; text: string }
  | { t: 'reply.done'; text: string }
  | { t: 'reply.error'; message: string }
  | { t: 'tts.start'; sample_rate: number }
  | { t: 'tts.done' }
  | { t: 'tts.error'; message: string };

export const phoneToDaemon = {
  rendezvousJoin: (input: { sessionId: string; delivery: DeliveryTarget }): PhoneToDaemon => ({
    t: 'rendezvous.join',
    sessionId: input.sessionId,
    delivery: input.delivery,
  }),
  sttStart: (): PhoneToDaemon => ({ t: 'stt.start' }),
  sttAudioDone: (): PhoneToDaemon => ({ t: 'stt.audio.done' }),
  sttCancel: (): PhoneToDaemon => ({ t: 'stt.cancel' }),
  replyCancel: (): PhoneToDaemon => ({ t: 'reply.cancel' }),
};

export const daemonToPhone = {
  rendezvousAccept: (roomId: string): DaemonToPhone => ({ t: 'rendezvous.accept', roomId }),
  rendezvousError: (message: string): DaemonToPhone => ({ t: 'rendezvous.error', message }),
  sttReady: (): DaemonToPhone => ({ t: 'stt.ready' }),
  sttPartial: (text: string, isFinal: boolean): DaemonToPhone => ({
    t: 'stt.partial',
    text,
    is_final: isFinal,
  }),
  sttDone: (text: string): DaemonToPhone => ({ t: 'stt.done', text }),
  sttError: (message: string): DaemonToPhone => ({ t: 'stt.error', message }),
  sttClosed: (): DaemonToPhone => ({ t: 'stt.closed' }),
  replyStart: (text: string): DaemonToPhone => ({ t: 'reply.start', text }),
  replyDone: (text: string): DaemonToPhone => ({ t: 'reply.done', text }),
  replyError: (message: string): DaemonToPhone => ({ t: 'reply.error', message }),
  ttsStart: (sampleRate: number): DaemonToPhone => ({
    t: 'tts.start',
    sample_rate: sampleRate,
  }),
  ttsDone: (): DaemonToPhone => ({ t: 'tts.done' }),
  ttsError: (message: string): DaemonToPhone => ({ t: 'tts.error', message }),
};
