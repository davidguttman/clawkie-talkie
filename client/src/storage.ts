// localStorage-backed settings persistence.
//
// Settings live on the device only. xAI API keys are held by the daemon
// (from the repo-root `.env`), NOT the phone — the browser never sees
// a key. Fields here are strictly UI/voice preferences.

export interface Settings {
  voice: string;
  speed: number;
  format: 'md' | 'txt' | 'json';
  timestamps: boolean;
}

const KEY = 'clawkie.settings.v1';
const TRANSCRIPTS_KEY = 'clawkie.transcripts.v1';

export const DEFAULT_SETTINGS: Settings = {
  voice: 'Samantha (en-US)',
  speed: 1.05,
  format: 'md',
  timestamps: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // storage full or disabled — settings won't persist, but the app still works.
  }
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
  settings: Pick<Settings, 'format' | 'timestamps'>,
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
