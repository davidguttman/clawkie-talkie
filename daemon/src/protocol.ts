// Wire protocol for the WebRTC DataChannel between the phone and
// daemon. Mirror of `client/src/voice/protocol.ts`; the protocol test
// pins both copies to the same serialized shape.
//
// Routing is bound once at rendezvous when the per-session voice room is
// created. `sessionId` remains the OpenClaw session identity; optional
// `sessionKey` selects the OpenClaw agent and can derive Discord reply and
// transcript routing. `channel`/`target` carry the explicit originating reply
// route when available. `stt.start` no longer carries routing per turn. Voice
// settings (legacy voice id plus
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

export interface RecentSession {
  sessionId: string;
  sessionKey: string;
  agent: string;
  channel?: string;
  target?: string;
  accountId?: string;
  lastActivity?: string;
  displayLabel: string;
  lastMessagePreview?: string;
  lastMessageRole?: string;
  lastAssistantPreview?: string;
}

export interface RecentSessionsSnapshot {
  generatedAt: string;
  sessions: RecentSession[];
}

// New-session destination catalog. The daemon is the trusted side: it
// reports which chat surfaces a brand-new OpenClaw session can be bound
// to. The browser never sees provider credentials — only ids, labels,
// and an availability status per provider. The daemon only emits
// providers it can actually create sessions for, backed by real channel
// destinations; providers without creatable channels are omitted. The
// status field stays on the wire so clients can filter defensively when
// talking to daemons with different emission rules.
export type NewSessionDestinationStatus = 'available' | 'unavailable' | 'unsupported';

export interface NewSessionDestinationOption {
  id: string;
  target: string;
  label: string;
  accountId?: string;
  group?: string;
}

export interface NewSessionDestinationProvider {
  id: string;
  label: string;
  kind: 'local' | 'channel';
  status: NewSessionDestinationStatus;
  statusDetail?: string;
  destinations: NewSessionDestinationOption[];
}

export interface NewSessionDestinationsCatalog {
  generatedAt: string;
  providers: NewSessionDestinationProvider[];
}

export interface NewSessionCreateInput {
  requestId: string;
  providerId: string;
  agent?: string;
  target?: string;
  accountId?: string;
}

export type VoiceTurnPhase =
  | 'idle'
  | 'recording'
  | 'thinking'
  | 'reply_ready'
  | 'speaking'
  | 'complete'
  | 'error';

export interface VoiceTurnSnapshot {
  inFlight: boolean;
  phase: VoiceTurnPhase;
  latestEventId: number;
  userText?: string;
  replyText?: string;
  error?: string;
  ttsSampleRate?: number;
}

export const PROTOCOL_VERSION = 1 as const;

export const PROTOCOL_FEATURES = {
  ttsCatalog: 'tts.catalog',
  sttCatalog: 'stt.catalog',
  sessionsList: 'sessions.list',
  sessionsCatalog: 'sessions.catalog',
  sessionsDestinations: 'sessions.destinations',
  sessionsCreate: 'sessions.create',
} as const;

export type ProtocolFeature = (typeof PROTOCOL_FEATURES)[keyof typeof PROTOCOL_FEATURES];

export const CLIENT_WANTED_PROTOCOL_FEATURES = [
  PROTOCOL_FEATURES.ttsCatalog,
  PROTOCOL_FEATURES.sttCatalog,
  PROTOCOL_FEATURES.sessionsList,
  PROTOCOL_FEATURES.sessionsCatalog,
  PROTOCOL_FEATURES.sessionsDestinations,
  PROTOCOL_FEATURES.sessionsCreate,
] as const satisfies readonly ProtocolFeature[];

export const DAEMON_SUPPORTED_PROTOCOL_FEATURES = [
  PROTOCOL_FEATURES.ttsCatalog,
  PROTOCOL_FEATURES.sttCatalog,
  PROTOCOL_FEATURES.sessionsList,
  PROTOCOL_FEATURES.sessionsCatalog,
  PROTOCOL_FEATURES.sessionsDestinations,
  PROTOCOL_FEATURES.sessionsCreate,
] as const satisfies readonly ProtocolFeature[];

export function isDaemonSupportedProtocol(protocol: unknown): protocol is typeof PROTOCOL_VERSION {
  return protocol === PROTOCOL_VERSION;
}

export interface ClientHello extends Record<string, unknown> {
  t: 'client.hello';
  protocol: typeof PROTOCOL_VERSION;
  wants: string[];
}

export interface DaemonHello extends Record<string, unknown> {
  t: 'daemon.hello';
  protocol: typeof PROTOCOL_VERSION;
  features: string[];
}

export interface DaemonUnsupported extends Record<string, unknown> {
  t: 'daemon.unsupported';
  minProtocol: typeof PROTOCOL_VERSION;
  maxProtocol: typeof PROTOCOL_VERSION;
  message: 'unsupported_daemon_protocol';
}

export type PhoneToDaemon =
  | ClientHello
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
  | { t: 'tts.catalog.request' }
  | { t: 'stt.catalog.request' }
  | { t: 'sessions.list.request' }
  | { t: 'sessions.catalog.request' }
  | { t: 'sessions.list.subscribe' }
  | { t: 'sessions.list.unsubscribe' }
  | { t: 'sessions.destinations.request' }
  | {
      t: 'sessions.create.request';
      requestId: string;
      providerId: string;
      agent?: string;
      target?: string;
      accountId?: string;
    }
  | { t: 'stt.start' }
  | { t: 'stt.audio.done' }
  | { t: 'stt.cancel' }
  | { t: 'reply.cancel' };

export type DaemonToPhoneEvent =
  | DaemonHello
  | DaemonUnsupported
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
  | { t: 'tts.start'; sample_rate: number; buffered?: boolean; turnId?: number; text?: string }
  | { t: 'tts.catalog'; catalog: TtsCatalog }
  | { t: 'stt.catalog'; catalog: SttCatalog }
  | { t: 'sessions.list'; generatedAt: string; sessions: RecentSession[] }
  | { t: 'sessions.catalog'; catalog: RecentSessionsSnapshot }
  | { t: 'sessions.destinations'; catalog: NewSessionDestinationsCatalog }
  | { t: 'sessions.created'; requestId: string; session: RecentSession }
  | { t: 'sessions.create.error'; requestId: string; message: string }
  | { t: 'tts.done' }
  | { t: 'tts.error'; message: string };

export interface ControlEventRecord {
  id: number;
  msg: DaemonToPhoneEvent;
}

export type DaemonToPhone =
  | DaemonToPhoneEvent
  | {
      t: 'session.snapshot';
      roomId: string;
      latestEventId: number;
      disconnectedMs?: number;
      turn: VoiceTurnSnapshot;
      events: ControlEventRecord[];
    };

export const phoneToDaemon = {
  clientHello: (wants: readonly string[] = CLIENT_WANTED_PROTOCOL_FEATURES): PhoneToDaemon => ({
    t: 'client.hello',
    protocol: PROTOCOL_VERSION,
    wants: [...wants],
  }),
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
  ttsCatalogRequest: (): PhoneToDaemon => ({ t: 'tts.catalog.request' }),
  sttCatalogRequest: (): PhoneToDaemon => ({ t: 'stt.catalog.request' }),
  sessionsListRequest: (): PhoneToDaemon => ({ t: 'sessions.list.request' }),
  sessionsCatalogRequest: (): PhoneToDaemon => ({ t: 'sessions.catalog.request' }),
  sessionsListSubscribe: (): PhoneToDaemon => ({ t: 'sessions.list.subscribe' }),
  sessionsListUnsubscribe: (): PhoneToDaemon => ({ t: 'sessions.list.unsubscribe' }),
  sessionsDestinationsRequest: (): PhoneToDaemon => ({ t: 'sessions.destinations.request' }),
  sessionsCreateRequest: (input: NewSessionCreateInput): PhoneToDaemon => ({
    t: 'sessions.create.request',
    requestId: input.requestId,
    providerId: input.providerId,
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.target ? { target: input.target } : {}),
    ...(input.accountId ? { accountId: input.accountId } : {}),
  }),
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
  // Legacy nested delivery payloads are ignored so they cannot override the
  // explicit reply route derived from current handoff metadata/session keys.
  return { ok: true };
}


export const daemonToPhone = {
  daemonHello: (features: readonly string[] = DAEMON_SUPPORTED_PROTOCOL_FEATURES): DaemonToPhone => ({
    t: 'daemon.hello',
    protocol: PROTOCOL_VERSION,
    features: [...features],
  }),
  daemonUnsupported: (): DaemonToPhone => ({
    t: 'daemon.unsupported',
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    message: 'unsupported_daemon_protocol',
  }),
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
  ttsStart: (sampleRate: number, options: { buffered?: boolean; turnId?: number; text?: string } = {}): DaemonToPhone => ({
    t: 'tts.start',
    sample_rate: sampleRate,
    ...(options.buffered ? { buffered: true } : {}),
    ...(typeof options.turnId === 'number' ? { turnId: options.turnId } : {}),
    ...(options.text ? { text: options.text } : {}),
  }),
  ttsCatalog: (catalog: TtsCatalog): DaemonToPhone => ({ t: 'tts.catalog', catalog }),
  sttCatalog: (catalog: SttCatalog): DaemonToPhone => ({ t: 'stt.catalog', catalog }),
  sessionsList: (snapshot: RecentSessionsSnapshot): DaemonToPhone => ({
    t: 'sessions.list',
    generatedAt: snapshot.generatedAt,
    sessions: snapshot.sessions,
  }),
  sessionsCatalog: (catalog: RecentSessionsSnapshot): DaemonToPhone => ({
    t: 'sessions.catalog',
    catalog,
  }),
  sessionsDestinations: (catalog: NewSessionDestinationsCatalog): DaemonToPhone => ({
    t: 'sessions.destinations',
    catalog,
  }),
  sessionsCreated: (requestId: string, session: RecentSession): DaemonToPhone => ({
    t: 'sessions.created',
    requestId,
    session,
  }),
  sessionsCreateError: (requestId: string, message: string): DaemonToPhone => ({
    t: 'sessions.create.error',
    requestId,
    message,
  }),
  sessionSnapshot: (input: {
    roomId: string;
    latestEventId: number;
    disconnectedMs?: number;
    turn: VoiceTurnSnapshot;
    events: ControlEventRecord[];
  }): DaemonToPhone => ({
    t: 'session.snapshot',
    roomId: input.roomId,
    latestEventId: input.latestEventId,
    ...(typeof input.disconnectedMs === 'number' ? { disconnectedMs: input.disconnectedMs } : {}),
    turn: input.turn,
    events: input.events,
  }),
  ttsDone: (): DaemonToPhone => ({ t: 'tts.done' }),
  ttsError: (message: string): DaemonToPhone => ({ t: 'tts.error', message }),
};

export function daemonHandshakeResponse(clientHello: { protocol?: unknown }): DaemonToPhone {
  return isDaemonSupportedProtocol(clientHello.protocol)
    ? daemonToPhone.daemonHello()
    : daemonToPhone.daemonUnsupported();
}
