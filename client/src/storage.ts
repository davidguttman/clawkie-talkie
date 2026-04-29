// localStorage-backed settings persistence.
//
// Settings live on the device only. Reply upstream credentials are held by
// the daemon (from the repo-root `.env`), NOT the phone — the browser never
// sees a key. Fields here are strictly UI/voice/export preferences.

import type {
  SttSelection as ProtocolSttSelection,
  TtsSelection as ProtocolTtsSelection,
} from './voice/protocol';

export type TtsSelection = ProtocolTtsSelection;
export type SttSelection = ProtocolSttSelection;

// Legacy static voice labels retained for migration/fallback display only.
// Storage normalization must not validate against them: provider support is
// discovered dynamically by the daemon.
export const VOICE_IDS = ['eve', 'ara', 'rex', 'sal', 'leo'] as const;
export type VoiceId = string;

export const VOICE_LABELS: Record<VoiceId, string> = {
  eve: 'Eve',
  ara: 'Ara',
  rex: 'Rex',
  sal: 'Sal',
  leo: 'Leo',
};

export type ExportFormat = 'md' | 'txt' | 'json';

export interface ExportSettings {
  format: ExportFormat;
  timestamps: boolean;
}

export interface Settings extends ExportSettings {
  // Temporary legacy mirror for callers that still read/write `settings.voice`.
  // New code should use `settings.tts.voice`.
  voice: string;
  tts: TtsSelection;
  stt: SttSelection;
}

const KEY = 'clawkie.settings.v1';
const TRANSCRIPTS_KEY = 'clawkie.transcripts.v1';

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: 'md',
  timestamps: false,
};

export const DEFAULT_SETTINGS: Settings = {
  voice: '',
  tts: {},
  stt: {},
  ...DEFAULT_EXPORT_SETTINGS,
};

export function loadSettings(): Settings {
  return normalizeSettings(readRawSettings());
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(normalizeSettingsForSave(settings)));
  } catch {
    // storage full or disabled — settings won't persist, but the app still works.
  }
}

// Export settings boundary — callers that only need export/history work
// can read these without importing the full Settings UI surface.
export function loadExportSettings(): ExportSettings {
  const settings = normalizeSettings(readRawSettings());
  return { format: settings.format, timestamps: settings.timestamps };
}

function readRawSettings(): unknown {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeSettings(value: unknown): Settings {
  const source = (value && typeof value === 'object') ? (value as Record<string, unknown>) : {};
  const tts = normalizeTtsSelection(source.tts, source.voice);
  const stt = normalizeSttSelection(source.stt);
  const voice = tts.voice ?? DEFAULT_SETTINGS.voice;
  const format: ExportFormat = source.format === 'txt' || source.format === 'json'
    ? source.format
    : 'md';
  const timestamps = typeof source.timestamps === 'boolean'
    ? source.timestamps
    : DEFAULT_SETTINGS.timestamps;
  return { voice, tts, stt, format, timestamps };
}

function normalizeSettingsForSave(settings: Settings): Settings {
  const legacyVoice = normalizeOptionalString(settings.voice);
  if (!legacyVoice) return normalizeSettings(settings);
  return normalizeSettings({
    ...settings,
    voice: legacyVoice,
    tts: {
      ...settings.tts,
      voice: legacyVoice,
    },
  });
}

function normalizeTtsSelection(value: unknown, legacyVoice: unknown): TtsSelection {
  const source = (value && typeof value === 'object') ? (value as Record<string, unknown>) : {};
  const providerId = normalizeOptionalString(source.providerId);
  const model = normalizeOptionalString(source.model);
  const voice = normalizeOptionalString(source.voice) ?? normalizeOptionalString(legacyVoice);
  return {
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    ...(voice ? { voice } : {}),
  };
}

function normalizeSttSelection(value: unknown): SttSelection {
  const source = (value && typeof value === 'object') ? (value as Record<string, unknown>) : {};
  const providerId = normalizeOptionalString(source.providerId);
  const model = normalizeOptionalString(source.model);
  return {
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export type TranscriptRole = 'user' | 'assistant';

export interface TranscriptTurn {
  id: string;
  role: TranscriptRole;
  text: string;
  createdAt: string;
  error?: string;
}

export interface TranscriptSession {
  id: string;
  threadId?: string;
  hostPeerId?: string;
  createdAt: string;
  updatedAt: string;
  turns: TranscriptTurn[];
}

interface TranscriptStore {
  sessions: TranscriptSession[];
}

export interface TranscriptSessionMeta {
  id: string;
  threadId?: string;
  hostPeerId?: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  preview: string;
}

export interface TranscriptSessionInput {
  sessionId: string;
  threadId?: string;
  hostPeerId?: string | null;
  now?: Date;
}

export interface TranscriptExport {
  filename: string;
  mime: string;
  body: string;
}

export function listTranscriptSessions(): TranscriptSessionMeta[] {
  return readTranscriptStore().sessions
    .map((session) => ({
      id: session.id,
      threadId: session.threadId,
      hostPeerId: session.hostPeerId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      turnCount: session.turns.length,
      preview: latestTurnPreview(session),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function loadTranscriptSession(sessionId: string): TranscriptSession | null {
  const id = sessionId.trim();
  if (!id) return null;
  const session = readTranscriptStore().sessions.find((item) => item.id === id);
  return session ? cloneSession(session) : null;
}

export function appendTranscriptTurn(
  input: TranscriptSessionInput,
  turn: Pick<TranscriptTurn, 'role' | 'text' | 'error'>,
): TranscriptSession | null {
  const sessionId = input.sessionId.trim();
  const text = turn.text.trim();
  if (!sessionId || (!text && !turn.error)) return null;

  const now = input.now ?? new Date();
  const iso = now.toISOString();
  const store = readTranscriptStore();
  const session = ensureTranscriptSession(store, input, iso);
  session.updatedAt = iso;
  if (input.threadId?.trim()) session.threadId = input.threadId.trim();
  if (input.hostPeerId?.trim()) session.hostPeerId = input.hostPeerId.trim();
  session.turns.push({
    id: createTurnId(now, session.turns.length),
    role: turn.role,
    text,
    createdAt: iso,
    ...(turn.error ? { error: turn.error } : {}),
  });
  writeTranscriptStore(store);
  return cloneSession(session);
}

export function latestAssistantText(session: TranscriptSession | null): string | null {
  if (!session) return null;
  for (let i = session.turns.length - 1; i >= 0; i -= 1) {
    const turn = session.turns[i];
    if (turn.role === 'assistant' && turn.text.trim()) return turn.text;
  }
  return null;
}

export function exportTranscript(
  session: TranscriptSession,
  settings: ExportSettings,
): TranscriptExport {
  const baseName = safeFilePart(session.id || 'transcript');
  const filename = `${baseName}.${settings.format}`;
  if (settings.format === 'json') {
    return {
      filename,
      mime: 'application/json',
      body: JSON.stringify(jsonExportPayload(session, settings.timestamps), null, 2) + '\n',
    };
  }
  if (settings.format === 'txt') {
    return {
      filename,
      mime: 'text/plain',
      body: textExportBody(session, settings.timestamps),
    };
  }
  return {
    filename,
    mime: 'text/markdown',
    body: markdownExportBody(session, settings.timestamps),
  };
}

function readTranscriptStore(): TranscriptStore {
  try {
    const raw = localStorage.getItem(TRANSCRIPTS_KEY);
    if (!raw) return { sessions: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.sessions)) return { sessions: [] };
    return {
      sessions: parsed.sessions
        .map(normalizeSession)
        .filter((session: TranscriptSession | null): session is TranscriptSession => !!session),
    };
  } catch {
    return { sessions: [] };
  }
}

function writeTranscriptStore(store: TranscriptStore): void {
  try {
    localStorage.setItem(TRANSCRIPTS_KEY, JSON.stringify(store));
  } catch {
    // Conversation history is local-only best effort. Voice still works if storage is full.
  }
}

function ensureTranscriptSession(
  store: TranscriptStore,
  input: TranscriptSessionInput,
  iso: string,
): TranscriptSession {
  const sessionId = input.sessionId.trim();
  let session = store.sessions.find((item) => item.id === sessionId);
  if (!session) {
    session = {
      id: sessionId,
      ...(input.threadId?.trim() ? { threadId: input.threadId.trim() } : {}),
      ...(input.hostPeerId?.trim() ? { hostPeerId: input.hostPeerId.trim() } : {}),
      createdAt: iso,
      updatedAt: iso,
      turns: [],
    };
    store.sessions.push(session);
  }
  return session;
}

function normalizeSession(value: unknown): TranscriptSession | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<TranscriptSession>;
  if (typeof source.id !== 'string' || !source.id.trim()) return null;
  const createdAt = typeof source.createdAt === 'string' ? source.createdAt : new Date(0).toISOString();
  const updatedAt = typeof source.updatedAt === 'string' ? source.updatedAt : createdAt;
  return {
    id: source.id.trim(),
    ...(typeof source.threadId === 'string' && source.threadId.trim()
      ? { threadId: source.threadId.trim() }
      : {}),
    ...(typeof source.hostPeerId === 'string' && source.hostPeerId.trim()
      ? { hostPeerId: source.hostPeerId.trim() }
      : {}),
    createdAt,
    updatedAt,
    turns: Array.isArray(source.turns)
      ? source.turns
          .map(normalizeTurn)
          .filter((turn: TranscriptTurn | null): turn is TranscriptTurn => !!turn)
      : [],
  };
}

function normalizeTurn(value: unknown): TranscriptTurn | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<TranscriptTurn>;
  const role = source.role === 'assistant' ? 'assistant' : source.role === 'user' ? 'user' : null;
  if (!role || typeof source.text !== 'string') return null;
  return {
    id: typeof source.id === 'string' && source.id.trim() ? source.id : createTurnId(new Date(), 0),
    role,
    text: source.text,
    createdAt:
      typeof source.createdAt === 'string' ? source.createdAt : new Date(0).toISOString(),
    ...(typeof source.error === 'string' && source.error ? { error: source.error } : {}),
  };
}

function cloneSession(session: TranscriptSession): TranscriptSession {
  return {
    ...session,
    turns: session.turns.map((turn) => ({ ...turn })),
  };
}

function latestTurnPreview(session: TranscriptSession): string {
  const turn = [...session.turns].reverse().find((item) => item.text.trim());
  if (!turn) return 'No turns saved yet';
  const prefix = turn.role === 'assistant' ? 'AI' : 'You';
  return `${prefix}: ${truncate(turn.text.trim(), 96)}`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function createTurnId(now: Date, index: number): string {
  return `${now.getTime().toString(36)}-${index.toString(36)}`;
}

function jsonExportPayload(session: TranscriptSession, timestamps: boolean) {
  return {
    sessionId: session.id,
    ...(session.threadId ? { threadId: session.threadId } : {}),
    ...(session.hostPeerId ? { hostPeerId: session.hostPeerId } : {}),
    ...(timestamps ? { createdAt: session.createdAt, updatedAt: session.updatedAt } : {}),
    turns: session.turns.map((turn) => ({
      role: turn.role,
      text: turn.text,
      ...(turn.error ? { error: turn.error } : {}),
      ...(timestamps ? { createdAt: turn.createdAt } : {}),
    })),
  };
}

function textExportBody(session: TranscriptSession, timestamps: boolean): string {
  const lines = [`Clawkie Talkie Transcript`, `Session: ${session.id}`];
  if (session.threadId) lines.push(`Thread: ${session.threadId}`);
  lines.push('');
  for (const turn of session.turns) {
    const who = turn.role === 'assistant' ? 'AI' : 'You';
    const stamp = timestamps ? `[${formatTimestamp(turn.createdAt)}] ` : '';
    const error = turn.error ? ` (${turn.error})` : '';
    lines.push(`${stamp}${who}${error}: ${turn.text}`);
  }
  return lines.join('\n').trimEnd() + '\n';
}

function markdownExportBody(session: TranscriptSession, timestamps: boolean): string {
  const lines = [`# Clawkie Talkie Transcript`, '', `- Session: \`${session.id}\``];
  if (session.threadId) lines.push(`- Thread: \`${session.threadId}\``);
  lines.push('');
  for (const turn of session.turns) {
    const who = turn.role === 'assistant' ? 'AI' : 'You';
    const stamp = timestamps ? ` _${formatTimestamp(turn.createdAt)}_` : '';
    const error = turn.error ? ` \`${turn.error}\`` : '';
    lines.push(`**${who}**${stamp}${error}`);
    lines.push('');
    lines.push(turn.text);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'transcript';
}
