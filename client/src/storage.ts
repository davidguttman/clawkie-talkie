// localStorage-backed settings persistence.
//
// Settings live on the device only. Reply upstream credentials are held by
// the daemon (from the repo-root `.env`), NOT the phone — the browser never
// sees a key. Fields here are strictly UI/voice/export preferences.

import type {
  RecentSession,
  SttSelection as ProtocolSttSelection,
  TtsSelection as ProtocolTtsSelection,
} from './voice/protocol';
import { notifyReplayAvailabilityChanged } from './replay';

export type TtsSelection = ProtocolTtsSelection;
export type SttSelection = ProtocolSttSelection;

// Legacy static voice labels retained for fallback display only.
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

export interface MusicSettings {
  muted: boolean;
  effects: boolean;
  volume: number;
  disabledTracks: string[];
}

export interface Settings extends ExportSettings {
  // Temporary legacy mirror for callers that still read/write `settings.voice`.
  // New code should use `settings.tts.voice`.
  voice: string;
  tts: TtsSelection;
  stt: SttSelection;
  music: MusicSettings;
}

const KEY = 'clawkie.settings.v1';
const HOLD_MUSIC_MUTE_STORAGE_KEY = 'clawkie.holdMusic.muted.v1';
const LAST_DASHBOARD_HOST_KEY = 'clawkie.dashboard.lastHost.v1';
const TRANSCRIPTS_KEY = 'clawkie.transcripts.v1';
const FAVORITE_SESSIONS_KEY = 'clawkie.favoriteSessions.v1';

export type FavoriteRecentSession = RecentSession;

export type RecentSessionFavoriteState = RecentSession & {
  favorite?: boolean;
  persistedFavorite?: boolean;
};

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: 'md',
  timestamps: false,
};

export const DEFAULT_MUSIC_SETTINGS: MusicSettings = {
  muted: false,
  effects: true,
  volume: 0.5,
  disabledTracks: [],
};

export const DEFAULT_SETTINGS: Settings = {
  voice: '',
  tts: {},
  stt: {},
  music: DEFAULT_MUSIC_SETTINGS,
  ...DEFAULT_EXPORT_SETTINGS,
};

export function loadLastDashboardHostPeerId(): string | null {
  try {
    return normalizeHostPeerId(localStorage.getItem(LAST_DASHBOARD_HOST_KEY)) ?? null;
  } catch {
    return null;
  }
}

export function saveLastDashboardHostPeerId(hostPeerId?: string | null): void {
  const hostKey = normalizeHostPeerId(hostPeerId);
  if (!hostKey) return;
  try {
    localStorage.setItem(LAST_DASHBOARD_HOST_KEY, hostKey);
  } catch {
    // storage disabled — PWA launch recovery simply won't remember the host.
  }
}

export function loadSettings(hostPeerId?: string | null): Settings {
  return normalizeSettings(readRawSettings(), hostPeerId);
}

export function saveSettings(settings: Settings, hostPeerId?: string | null): void {
  try {
    const normalized = normalizeSettingsForSave(settings, hostPeerId);
    localStorage.setItem(KEY, JSON.stringify(normalized));
    writeLegacyHoldMusicMute(normalizeMusicSettings(settings.music).muted);
  } catch {
    // storage full or disabled — settings won't persist, but the app still works.
  }
}

export function loadMusicSettings(): MusicSettings {
  return normalizeMusicSettings(readRawSettings());
}

export function saveMusicSettings(settings: MusicSettings): void {
  try {
    const existing = objectRecord(readRawSettings());
    const next: Record<string, unknown> = { ...existing };
    const music = normalizeMusicSettings(settings);
    if (isDefaultMusicSettings(music)) delete next.music;
    else next.music = music;
    localStorage.setItem(KEY, JSON.stringify(next));
    writeLegacyHoldMusicMute(music.muted);
  } catch {
    // storage disabled — music preferences revert to default on reload.
  }
}


export function loadFavoriteRecentSessions(hostPeerId?: string | null): FavoriteRecentSession[] {
  const hostKey = normalizeHostPeerId(hostPeerId);
  if (!hostKey) return [];
  return readFavoriteSessionStore().hosts[hostKey]?.sessions.map(cloneRecentSession) ?? [];
}

export function saveFavoriteRecentSession(
  hostPeerId: string | null | undefined,
  session: RecentSession,
): FavoriteRecentSession | null {
  const hostKey = normalizeHostPeerId(hostPeerId);
  const normalized = normalizeFavoriteRecentSession(session);
  if (!hostKey || !normalized) return null;
  const store = readFavoriteSessionStore();
  const host = store.hosts[hostKey] ?? { sessions: [] };
  const key = recentSessionStorageKey(normalized);
  host.sessions = [
    normalized,
    ...host.sessions.filter((item) => recentSessionStorageKey(item) !== key),
  ];
  store.hosts[hostKey] = host;
  writeFavoriteSessionStore(store);
  return cloneRecentSession(normalized);
}

export function removeFavoriteRecentSession(
  hostPeerId: string | null | undefined,
  session: Partial<Pick<RecentSession, 'sessionId' | 'sessionKey'>>,
): void {
  const hostKey = normalizeHostPeerId(hostPeerId);
  const sessionKey = recentSessionStorageKey(session);
  if (!hostKey || !sessionKey) return;
  const store = readFavoriteSessionStore();
  const host = store.hosts[hostKey];
  if (!host) return;
  host.sessions = host.sessions.filter((item) => !favoriteRecentSessionIdentityMatches(item, session));
  if (host.sessions.length > 0) {
    store.hosts[hostKey] = host;
  } else {
    delete store.hosts[hostKey];
  }
  writeFavoriteSessionStore(store);
}

export function reconcileFavoriteRecentSessions(
  hostPeerId: string | null | undefined,
  daemonSessions: RecentSession[],
): FavoriteRecentSession[] {
  const hostKey = normalizeHostPeerId(hostPeerId);
  if (!hostKey) return [];
  const store = readFavoriteSessionStore();
  const host = store.hosts[hostKey];
  if (!host || host.sessions.length === 0) return [];
  const daemonByKey = new Map<string, FavoriteRecentSession>();
  for (const session of daemonSessions) {
    const normalized = normalizeFavoriteRecentSession(session);
    const key = normalized ? recentSessionStorageKey(normalized) : undefined;
    if (normalized && key) daemonByKey.set(key, normalized);
  }
  let changed = false;
  host.sessions = host.sessions.map((favorite) => {
    const key = recentSessionStorageKey(favorite);
    const fresh = key ? daemonByKey.get(key) : undefined;
    if (fresh) changed = true;
    return fresh ?? favorite;
  });
  store.hosts[hostKey] = host;
  if (changed) writeFavoriteSessionStore(store);
  return host.sessions.map(cloneRecentSession);
}

export function mergeRecentSessionsWithFavorites(
  daemonSessions: RecentSession[],
  favoriteSessions: FavoriteRecentSession[],
): RecentSessionFavoriteState[] {
  const favoritesByKey = new Map<string, FavoriteRecentSession>();
  for (const session of favoriteSessions) {
    const normalized = normalizeFavoriteRecentSession(session);
    const key = normalized ? recentSessionStorageKey(normalized) : undefined;
    if (normalized && key) favoritesByKey.set(key, normalized);
  }

  const seen = new Set<string>();
  const favoriteRows: RecentSessionFavoriteState[] = [];
  const nonFavoriteRows: RecentSessionFavoriteState[] = [];
  for (const session of daemonSessions) {
    const normalized = normalizeFavoriteRecentSession(session);
    if (!normalized) continue;
    const key = recentSessionStorageKey(normalized);
    if (!key) continue;
    seen.add(key);
    const favorite = favoritesByKey.has(key);
    const row: RecentSessionFavoriteState = {
      ...normalized,
      ...(favorite ? { favorite: true } : {}),
    };
    if (favorite) favoriteRows.push(row);
    else nonFavoriteRows.push(row);
  }

  for (const favorite of favoriteSessions) {
    const normalized = normalizeFavoriteRecentSession(favorite);
    const key = normalized ? recentSessionStorageKey(normalized) : undefined;
    if (!normalized || !key || seen.has(key)) continue;
    favoriteRows.push({ ...normalized, favorite: true, persistedFavorite: true });
  }

  return [...favoriteRows, ...nonFavoriteRows];
}

// Export settings boundary — callers that only need export/history work
// can read these without importing the full Settings UI surface. Export prefs
// remain global; voice/provider selections are host-scoped under `hosts`.
export function loadExportSettings(): ExportSettings {
  return normalizeExportSettings(readRawSettings());
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

function normalizeSettings(value: unknown, hostPeerId?: string | null): Settings {
  const exportSettings = normalizeExportSettings(value);
  const music = normalizeMusicSettings(value);
  const source = readHostSettings(value, hostPeerId);
  const tts = normalizeTtsSelection(source.tts, source.voice);
  const stt = normalizeSttSelection(source.stt);
  const voice = tts.voice ?? DEFAULT_SETTINGS.voice;
  return { voice, tts, stt, music, ...exportSettings };
}

function normalizeSettingsForSave(
  settings: Settings,
  hostPeerId?: string | null,
): Record<string, unknown> {
  const existing = objectRecord(readRawSettings());
  const next: Record<string, unknown> = { ...normalizeExportSettings(settings) };
  const music = normalizeMusicSettings(settings.music);
  if (!isDefaultMusicSettings(music)) next.music = music;
  const hosts = cloneHosts(existing.hosts);
  const hostKey = normalizeHostPeerId(hostPeerId);
  if (hostKey) hosts[hostKey] = normalizeHostSettingsForSave(settings);
  if (Object.keys(hosts).length > 0) next.hosts = hosts;
  return next;
}

function normalizeHostSettingsForSave(settings: Settings): Record<string, unknown> {
  const legacyVoice = normalizeOptionalString(settings.voice);
  const tts = normalizeTtsSelection(
    legacyVoice ? { ...settings.tts, voice: legacyVoice } : settings.tts,
    undefined,
  );
  return {
    voice: tts.voice ?? DEFAULT_SETTINGS.voice,
    tts,
    stt: normalizeSttSelection(settings.stt),
  };
}

function normalizeExportSettings(value: unknown): ExportSettings {
  const source = objectRecord(value);
  const format: ExportFormat = source.format === 'txt' || source.format === 'json'
    ? source.format
    : DEFAULT_EXPORT_SETTINGS.format;
  const timestamps = typeof source.timestamps === 'boolean'
    ? source.timestamps
    : DEFAULT_EXPORT_SETTINGS.timestamps;
  return { format, timestamps };
}


function normalizeMusicSettings(value: unknown): MusicSettings {
  const source = objectRecord(objectRecord(value).music ?? value);
  const muted = typeof source.muted === 'boolean'
    ? source.muted
    : readLegacyHoldMusicMuted();
  const effects = typeof source.effects === 'boolean'
    ? source.effects
    : DEFAULT_MUSIC_SETTINGS.effects;
  const volume = normalizeMusicVolume(source.volume);
  const disabledTracks = Array.isArray(source.disabledTracks)
    ? uniqueStrings(source.disabledTracks)
    : DEFAULT_MUSIC_SETTINGS.disabledTracks;
  return { muted, effects, volume, disabledTracks };
}

function isDefaultMusicSettings(settings: MusicSettings): boolean {
  return settings.muted === DEFAULT_MUSIC_SETTINGS.muted
    && settings.effects === DEFAULT_MUSIC_SETTINGS.effects
    && settings.volume === DEFAULT_MUSIC_SETTINGS.volume
    && settings.disabledTracks.length === 0;
}

function normalizeMusicVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MUSIC_SETTINGS.volume;
  return Math.min(1, Math.max(0, value));
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function readLegacyHoldMusicMuted(): boolean {
  try {
    return localStorage.getItem(HOLD_MUSIC_MUTE_STORAGE_KEY) === '1';
  } catch {
    return DEFAULT_MUSIC_SETTINGS.muted;
  }
}

function writeLegacyHoldMusicMute(muted: boolean): void {
  try {
    if (muted) {
      localStorage.setItem(HOLD_MUSIC_MUTE_STORAGE_KEY, '1');
    } else if (typeof localStorage.removeItem === 'function') {
      localStorage.removeItem(HOLD_MUSIC_MUTE_STORAGE_KEY);
    } else {
      localStorage.setItem(HOLD_MUSIC_MUTE_STORAGE_KEY, '0');
    }
  } catch {
    // Legacy mirror is best-effort only.
  }
}

function readHostSettings(value: unknown, hostPeerId?: string | null): Record<string, unknown> {
  const hostKey = normalizeHostPeerId(hostPeerId);
  if (!hostKey) return {};
  const hosts = objectRecord(objectRecord(value).hosts);
  return objectRecord(hosts[hostKey]);
}

function cloneHosts(value: unknown): Record<string, unknown> {
  const hosts = objectRecord(value);
  const next: Record<string, unknown> = {};
  for (const [key, settings] of Object.entries(hosts)) {
    const hostKey = normalizeHostPeerId(key);
    if (!hostKey) continue;
    const hostSettings = objectRecord(settings);
    if (Object.keys(hostSettings).length > 0) next[hostKey] = hostSettings;
  }
  return next;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeHostPeerId(value: unknown): string | undefined {
  return normalizeOptionalString(value);
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


interface FavoriteRecentSessionStore {
  hosts: Record<string, { sessions: FavoriteRecentSession[] }>;
}

function readFavoriteSessionStore(): FavoriteRecentSessionStore {
  try {
    const raw = localStorage.getItem(FAVORITE_SESSIONS_KEY);
    if (!raw) return { hosts: {} };
    const parsed = JSON.parse(raw);
    return normalizeFavoriteSessionStore(parsed);
  } catch {
    return { hosts: {} };
  }
}

function writeFavoriteSessionStore(store: FavoriteRecentSessionStore): void {
  try {
    localStorage.setItem(FAVORITE_SESSIONS_KEY, JSON.stringify(normalizeFavoriteSessionStore(store)));
  } catch {
    // Favorite sessions are best-effort local UI state. The live daemon list still works.
  }
}

function normalizeFavoriteSessionStore(value: unknown): FavoriteRecentSessionStore {
  const source = objectRecord(value);
  const hosts = objectRecord(source.hosts);
  const normalizedHosts: FavoriteRecentSessionStore['hosts'] = {};
  for (const [rawHostKey, rawHost] of Object.entries(hosts)) {
    const hostKey = normalizeHostPeerId(rawHostKey);
    if (!hostKey) continue;
    const rawSessions = Array.isArray(rawHost)
      ? rawHost
      : Array.isArray(objectRecord(rawHost).sessions)
        ? (objectRecord(rawHost).sessions as unknown[])
        : [];
    const sessions = rawSessions
      .map(normalizeFavoriteRecentSession)
      .filter((session: FavoriteRecentSession | null): session is FavoriteRecentSession => !!session);
    const deduped: FavoriteRecentSession[] = [];
    const seen = new Set<string>();
    for (const session of sessions) {
      const key = recentSessionStorageKey(session);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(session);
    }
    if (deduped.length > 0) normalizedHosts[hostKey] = { sessions: deduped };
  }
  return { hosts: normalizedHosts };
}

export function normalizeFavoriteRecentSession(value: unknown): FavoriteRecentSession | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<RecentSession>;
  const sessionId = normalizeOptionalString(source.sessionId);
  const sessionKey = normalizeOptionalString(source.sessionKey);
  if (!sessionId || !sessionKey) return null;
  const agent = normalizeOptionalString(source.agent) ?? 'unknown';
  const displayLabel = normalizeOptionalString(source.displayLabel) ?? agent;
  const channel = normalizeOptionalString(source.channel);
  const target = normalizeOptionalString(source.target);
  const accountId = normalizeOptionalString(source.accountId);
  const lastActivity = normalizeOptionalString(source.lastActivity);
  return {
    sessionId,
    sessionKey,
    agent,
    displayLabel,
    ...(channel ? { channel } : {}),
    ...(target ? { target } : {}),
    ...(accountId ? { accountId } : {}),
    ...(lastActivity ? { lastActivity } : {}),
  };
}

export function favoriteRecentSessionIdentity(
  session: Partial<Pick<RecentSession, 'sessionId' | 'sessionKey'>>,
): string | undefined {
  const sessionKey = normalizeOptionalString(session.sessionKey);
  if (sessionKey) return `sessionKey:${sessionKey}`;
  const sessionId = normalizeOptionalString(session.sessionId);
  return sessionId ? `sessionId:${sessionId}` : undefined;
}

function favoriteRecentSessionIdentityMatches(
  left: Partial<Pick<RecentSession, 'sessionId' | 'sessionKey'>>,
  right: Partial<Pick<RecentSession, 'sessionId' | 'sessionKey'>>,
): boolean {
  const leftSessionKey = normalizeOptionalString(left.sessionKey);
  const rightSessionKey = normalizeOptionalString(right.sessionKey);
  if (leftSessionKey && rightSessionKey) return leftSessionKey === rightSessionKey;

  const leftSessionId = normalizeOptionalString(left.sessionId);
  const rightSessionId = normalizeOptionalString(right.sessionId);
  return !!leftSessionId && !!rightSessionId && leftSessionId === rightSessionId;
}

function recentSessionStorageKey(
  session: Partial<Pick<RecentSession, 'sessionId' | 'sessionKey'>>,
): string | undefined {
  return favoriteRecentSessionIdentity(session);
}

function cloneRecentSession(session: FavoriteRecentSession): FavoriteRecentSession {
  return { ...session };
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
  if (turn.role === 'assistant' && text) notifyReplayAvailabilityChanged();
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
