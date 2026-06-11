// Real Discord channel catalog for the New Session picker.
//
// The picker must list parent channels the daemon/OpenClaw can actually
// write to — not recent session rows, which are threads/DMs/stale
// targets and read as an incoherent channel list. The catalog comes
// from `openclaw message channel list --channel discord --json`.
// OpenClaw output shapes vary across versions, so parsing is defensive:
// it searches the parsed JSON for arrays of channel-shaped entries
// instead of pinning one wrapper shape (the same approach newSession.ts
// takes for thread-create output).
//
// Filtering fails closed on explicit type info: only thread-capable
// parent channels (text/announcement/forum/media) are kept, while
// threads, DMs, voice/stage channels, categories, and unrecognized
// explicit types are dropped. Entries that carry no type information at
// all are kept — a minimal `{id, name}` listing from a guild channel
// listing command is assumed to be writable text channels.
//
// If the bare listing yields nothing, the daemon retries per guild with
// guild ids inferred from the OpenClaw config (`guildId`-style keys and
// `guilds` maps/arrays under the discord channel config) — never from a
// hard-coded id. When no channels can be discovered at all the caller
// reports Discord as unavailable instead of inventing destinations.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { NewSessionDestinationOption } from './protocol.js';
import { getOpenClawConfigPath } from './recentSessions.js';
import {
  collectChannelEntryArrays,
  parseJsonCandidates,
  readEntryId,
  readEntryName,
  readId,
  readObject,
  readString,
  type OpenClawExec,
} from './channelCatalog.js';

export { parseJsonCandidates } from './channelCatalog.js';
export type { OpenClawExec } from './channelCatalog.js';

const execFileAsync = promisify(execFile);

const CHANNEL_LIST_TIMEOUT_MS = 10_000;

// Ids are forwarded to the OpenClaw CLI as `channel:<id>`; keep the charset tight.
const SAFE_DISCORD_ID = /^[A-Za-z0-9_-]+$/;
// Discord guild ids are numeric snowflakes.
const DISCORD_GUILD_ID = /^\d{15,21}$/;
const GUILD_ID_CONFIG_KEY = /^(?:default[_-]?)?guild[_-]?id$/i;

// Discord channel type enum: thread-capable parents vs everything else.
const PARENT_CHANNEL_TYPES = new Set([0, 5, 15, 16]); // text, announcement, forum, media
const PARENT_CHANNEL_TYPE_WORDS = ['text', 'announcement', 'news', 'forum', 'media'];
const EXCLUDED_CHANNEL_TYPE_PATTERN = /thread|dm\b|direct|voice|stage|category|directory|group/;

export interface DiscordChannelCatalogEntry {
  id: string;
  name?: string;
  guildId?: string;
  guildName?: string;
}

type ChannelTypeVerdict = 'parent' | 'excluded' | 'untyped';

function classifyChannelType(record: Record<string, unknown>): ChannelTypeVerdict {
  if (record.isThread === true || record.thread === true || record.isDm === true
    || record.isDM === true || record.dm === true) {
    return 'excluded';
  }
  // DM entries in mixed listings carry recipient/user fields instead of a guild channel name.
  if (record.recipient !== undefined || record.recipients !== undefined) return 'excluded';

  const typeValue = record.type ?? record.channelType ?? record.channel_type ?? record.kind;
  if (typeValue === undefined || typeValue === null) return 'untyped';
  if (typeof typeValue === 'number' && Number.isFinite(typeValue)) {
    return PARENT_CHANNEL_TYPES.has(typeValue) ? 'parent' : 'excluded';
  }
  const typeWord = readString(typeValue)?.toLowerCase();
  if (!typeWord) return 'untyped';
  if (EXCLUDED_CHANNEL_TYPE_PATTERN.test(typeWord)) return 'excluded';
  if (PARENT_CHANNEL_TYPE_WORDS.some((word) => typeWord.includes(word))) return 'parent';
  // Unknown explicit type: fail closed rather than offering a non-writable surface.
  return 'excluded';
}

function normalizeChannelEntry(value: unknown): DiscordChannelCatalogEntry | undefined {
  const record = readObject(value);
  if (!record) return undefined;
  const id = readEntryId(record);
  if (!id || !SAFE_DISCORD_ID.test(id)) return undefined;
  if (classifyChannelType(record) === 'excluded') return undefined;

  const guild = readObject(record.guild);
  const name = readEntryName(record);
  const guildId = readId(record.guildId) ?? readId(record.guild_id) ?? readId(guild?.id);
  const guildName = readString(record.guildName) ?? readString(record.guild_name) ?? readString(guild?.name);
  return {
    id,
    ...(name ? { name } : {}),
    ...(guildId ? { guildId } : {}),
    ...(guildName ? { guildName } : {}),
  };
}

export function parseDiscordChannelListOutput(stdout: string): DiscordChannelCatalogEntry[] {
  const arrays: unknown[][] = [];
  for (const candidate of parseJsonCandidates(stdout)) {
    collectChannelEntryArrays(candidate, 0, arrays);
  }
  const entries = new Map<string, DiscordChannelCatalogEntry>();
  for (const array of arrays) {
    for (const item of array) {
      const entry = normalizeChannelEntry(item);
      if (!entry) continue;
      const existing = entries.get(entry.id);
      // Prefer the entry that carries a human channel name.
      if (!existing || (!existing.name && entry.name)) entries.set(entry.id, entry);
    }
  }
  return [...entries.values()];
}

export function discordChannelDestinationLabel(entry: DiscordChannelCatalogEntry): string {
  if (!entry.name) return `channel ${entry.id}`;
  return entry.name.startsWith('#') ? entry.name : `#${entry.name}`;
}

export function buildDiscordChannelDestinations(
  entries: DiscordChannelCatalogEntry[],
): NewSessionDestinationOption[] {
  return entries
    .map((entry): NewSessionDestinationOption => ({
      id: `discord:channel:${entry.id}`,
      target: `channel:${entry.id}`,
      label: discordChannelDestinationLabel(entry),
      ...(entry.guildName ? { group: entry.guildName } : {}),
    }))
    .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.label.localeCompare(b.label));
}

function collectGuildIds(value: unknown, depth: number, out: Set<string>): void {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = readId(item);
      if (id && DISCORD_GUILD_ID.test(id)) out.add(id);
      else collectGuildIds(item, depth + 1, out);
    }
    return;
  }
  const record = readObject(value);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    if (GUILD_ID_CONFIG_KEY.test(key)) {
      const id = readId(entry);
      if (id && DISCORD_GUILD_ID.test(id)) out.add(id);
      continue;
    }
    if (key === 'guilds') {
      const guilds = readObject(entry);
      if (guilds) {
        for (const guildKey of Object.keys(guilds)) {
          if (DISCORD_GUILD_ID.test(guildKey)) out.add(guildKey);
        }
      }
      collectGuildIds(entry, depth + 1, out);
      continue;
    }
    collectGuildIds(entry, depth + 1, out);
  }
}

// Guild ids come from whatever discord config OpenClaw already holds:
// `guildId`/`defaultGuildId` keys or `guilds` maps/arrays anywhere under
// `channels.discord` (or a top-level `discord` section). No id is ever
// hard-coded in source.
export function extractDiscordGuildIdsFromConfig(config: unknown): string[] {
  const record = readObject(config);
  if (!record) return [];
  const channels = readObject(record.channels);
  const discord = readObject(channels?.discord) ?? readObject(record.discord);
  if (!discord) return [];
  const out = new Set<string>();
  collectGuildIds(discord, 0, out);
  return [...out];
}

export async function loadDiscordGuildIdsFromOpenClawConfig(
  options: { readConfig?: () => Promise<string> } = {},
): Promise<string[]> {
  const readConfig = options.readConfig ?? (() => readFile(getOpenClawConfigPath(), 'utf8'));
  let raw: string;
  try {
    raw = await readConfig();
  } catch {
    return [];
  }
  try {
    return extractDiscordGuildIdsFromConfig(JSON.parse(raw));
  } catch {
    // Non-strict-JSON configs (comments, JSON5) are out of scope; the
    // bare `channel list` call remains the primary discovery path.
    return [];
  }
}

export interface ListDiscordChannelDestinationsOptions {
  execOpenClaw?: OpenClawExec;
  loadGuildIds?: () => Promise<string[]>;
}

// Returns [] when OpenClaw cannot provide a real channel catalog; the
// caller maps an empty list to an unavailable Discord provider instead
// of falling back to recent-session rows as fake channels.
export async function listDiscordChannelDestinations(
  options: ListDiscordChannelDestinationsOptions = {},
): Promise<NewSessionDestinationOption[]> {
  const exec = options.execOpenClaw
    ?? ((command, args) => execFileAsync(command, args, { timeout: CHANNEL_LIST_TIMEOUT_MS, windowsHide: true }));
  const baseArgs = ['message', 'channel', 'list', '--channel', 'discord', '--json'];

  const entries = new Map<string, DiscordChannelCatalogEntry>();
  const addAll = (parsed: DiscordChannelCatalogEntry[]) => {
    for (const entry of parsed) {
      const existing = entries.get(entry.id);
      if (!existing || (!existing.name && entry.name)) entries.set(entry.id, entry);
    }
  };

  try {
    addAll(parseDiscordChannelListOutput((await exec('openclaw', baseArgs)).stdout));
  } catch {
    // Fall through to per-guild discovery.
  }

  if (entries.size === 0) {
    const loadGuildIds = options.loadGuildIds ?? loadDiscordGuildIdsFromOpenClawConfig;
    let guildIds: string[] = [];
    try {
      guildIds = await loadGuildIds();
    } catch {
      guildIds = [];
    }
    for (const guildId of guildIds) {
      if (!DISCORD_GUILD_ID.test(guildId)) continue;
      try {
        addAll(parseDiscordChannelListOutput(
          (await exec('openclaw', [...baseArgs, '--guild-id', guildId])).stdout,
        ));
      } catch {
        // A missing guild just contributes no channels.
      }
    }
  }

  return buildDiscordChannelDestinations([...entries.values()]);
}
