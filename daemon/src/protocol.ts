// Wire protocol for the WebRTC DataChannel between the phone and
// daemon. Mirror of `client/src/voice/protocol.ts`; the protocol test
// pins both copies to the same serialized shape.
//
// Routing (sessionId) is bound once at
// rendezvous when the per-session voice room is created. Optional sessionKey
// is routing metadata for transcript mirroring only; it is never used as the
// agent session identity. `stt.start`
// no longer carries routing per turn. Voice settings (legacy voice id plus
// canonical TTS provider/model/voice selection) flow over the voice room:
// an initial value is included in
// `rendezvous.join` so the first reply uses it, and `settings.update`
// applies subsequent changes without reconnecting. The phone can request
// the daemon's current TTS catalog over the same channel.

export interface DeliveryTarget {
  channel: string;
  target: string;
  accountId?: string;
}

export interface RendezvousJoinInput {
  sessionId: string;
  sessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
  delivery?: DeliveryTarget;
}

export interface TtsSelection {
  providerId?: string;
  model?: string;
  voice?: string;
}

export interface SttSelection {
  providerId?: string;
  model?: string;
}

export interface VoiceSettings {
  voice?: string;
  tts?: TtsSelection;
  stt?: SttSelection;
}

export interface TtsCatalogVoice {
  id: string;
  name: string;
}

export interface TtsCatalogProvider {
  id: string;
  name: string;
  configured: boolean;
  selected: boolean;
  available: boolean;
  models: string[];
  voices: TtsCatalogVoice[];
}

export interface TtsCatalog {
  activeProvider?: string;
  generatedAt: string;
  providers: TtsCatalogProvider[];
}

export interface SttCatalogProvider {
  id: string;
  name: string;
  configured: boolean;
  selected: boolean;
  available: boolean;
  models: string[];
}

export interface SttCatalog {
  activeProvider?: string;
  generatedAt: string;
  providers: SttCatalogProvider[];
}

export interface RecentSessionEntry {
  id: string;
  label: string;
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  channel?: string;
  target?: string;
  accountId?: string;
  kind?: string;
  lastActivity?: string;
}

export interface RecentSessionsSnapshot {
  generatedAt: string;
  sessions: RecentSessionEntry[];
}

export type PhoneToDaemon =
  | {
      t: 'rendezvous.join';
      sessionId: string;
      sessionKey?: string;
      channel?: string;
      target?: string;
      accountId?: string;
      delivery?: DeliveryTarget;
      settings?: VoiceSettings;
    }
  | { t: 'settings.update'; settings: VoiceSettings }
  | { t: 'sessions.catalog.request' }
  | { t: 'tts.catalog.request' }
  | { t: 'stt.catalog.request' }
  | { t: 'stt.start' }
  | { t: 'stt.audio.done' }
  | { t: 'stt.cancel' }
  | { t: 'reply.cancel' };

export type DaemonToPhone =
  | { t: 'rendezvous.accept'; roomId: string }
  | { t: 'rendezvous.error'; message: string }
  | { t: 'session.replaced'; reason: string }
  | { t: 'stt.ready' }
  | { t: 'stt.partial'; text: string; is_final: boolean }
  | { t: 'stt.done'; text: string }
  | { t: 'stt.error'; message: string }
  | { t: 'stt.closed' }
  | { t: 'reply.start'; text: string }
  | { t: 'reply.done'; text: string }
  | { t: 'reply.error'; message: string }
  | { t: 'tts.start'; sample_rate: number }
  | { t: 'tts.catalog'; catalog: TtsCatalog }
  | { t: 'stt.catalog'; catalog: SttCatalog }
  | { t: 'sessions.catalog'; catalog: RecentSessionsSnapshot }
  | { t: 'tts.done' }
  | { t: 'tts.error'; message: string };

export const phoneToDaemon = {
  rendezvousJoin: (input: RendezvousJoinInput & { settings?: VoiceSettings }): PhoneToDaemon => ({
    t: 'rendezvous.join',
    sessionId: input.sessionId,
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.target ? { target: input.target } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.settings ? { settings: input.settings } : {}),
  }),
  settingsUpdate: (settings: VoiceSettings): PhoneToDaemon => ({
    t: 'settings.update',
    settings,
  }),
  sessionsCatalogRequest: (): PhoneToDaemon => ({ t: 'sessions.catalog.request' }),
  ttsCatalogRequest: (): PhoneToDaemon => ({ t: 'tts.catalog.request' }),
  sttCatalogRequest: (): PhoneToDaemon => ({ t: 'stt.catalog.request' }),
  sttStart: (): PhoneToDaemon => ({ t: 'stt.start' }),
  sttAudioDone: (): PhoneToDaemon => ({ t: 'stt.audio.done' }),
  sttCancel: (): PhoneToDaemon => ({ t: 'stt.cancel' }),
  replyCancel: (): PhoneToDaemon => ({ t: 'reply.cancel' }),
};

export interface MirroredDeliveryTarget {
  channel: string;
  target: string;
  accountId?: string;
}

export type RendezvousDeliveryValidation =
  | { ok: true; delivery?: MirroredDeliveryTarget }
  | { ok: false; message: 'invalid_delivery' };

export function validateRendezvousDelivery(
  _delivery: Partial<DeliveryTarget> | null | undefined,
): RendezvousDeliveryValidation {
  // Public handoff routing uses top-level channel/target/accountId metadata.
  // Legacy nested delivery payloads are ignored so they cannot block the
  // session-bound agent turn.
  return { ok: true };
}


export const daemonToPhone = {
  rendezvousAccept: (roomId: string): DaemonToPhone => ({ t: 'rendezvous.accept', roomId }),
  rendezvousError: (message: string): DaemonToPhone => ({ t: 'rendezvous.error', message }),
  sessionReplaced: (reason = 'newer_phone_connected'): DaemonToPhone => ({
    t: 'session.replaced',
    reason,
  }),
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
  ttsCatalog: (catalog: TtsCatalog): DaemonToPhone => ({ t: 'tts.catalog', catalog }),
  sttCatalog: (catalog: SttCatalog): DaemonToPhone => ({ t: 'stt.catalog', catalog }),
  sessionsCatalog: (catalog: RecentSessionsSnapshot): DaemonToPhone => ({ t: 'sessions.catalog', catalog }),
  ttsDone: (): DaemonToPhone => ({ t: 'tts.done' }),
  ttsError: (message: string): DaemonToPhone => ({ t: 'tts.error', message }),
};
