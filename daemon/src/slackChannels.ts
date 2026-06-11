// Real Slack channel catalog for the New Session picker.
//
// The picker must list parent channels the daemon/OpenClaw can actually
// post to — not recent session rows, which are threads/DMs/stale
// targets. The catalog comes from
// `openclaw message channel list --channel slack --json`, parsed with
// the shared defensive channel-catalog helpers (channelCatalog.ts).
//
// Filtering fails closed on explicit type info: only conversations that
// look like real channels (public/private channels, legacy groups) are
// kept; IMs, multi-party IMs, archived conversations, and unrecognized
// explicit types are dropped. Entries with no type information at all
// are kept when their id does not look like a DM — a minimal
// `{id, name}` listing is assumed to be postable channels — except
// `D…`-prefixed ids, which are Slack DM conversations.
//
// When no channels can be discovered the caller omits Slack from the
// destination choices instead of inventing destinations.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NewSessionDestinationOption } from './protocol.js';
import {
  collectChannelEntryArrays,
  parseJsonCandidates,
  readEntryId,
  readEntryName,
  readObject,
  readString,
  type OpenClawExec,
} from './channelCatalog.js';

const execFileAsync = promisify(execFile);

const CHANNEL_LIST_TIMEOUT_MS = 10_000;

// Ids are forwarded to the OpenClaw CLI as `channel:<id>`; keep the charset tight.
const SAFE_SLACK_ID = /^[A-Za-z0-9_-]+$/;
// Slack conversation ids are typed by prefix: C=channel, G=legacy
// private channel/group, D=direct message.
const SLACK_DM_ID = /^D[A-Z0-9]{6,}$/;

const CHANNEL_TYPE_WORDS = ['channel', 'public_channel', 'private_channel', 'group'];
const EXCLUDED_TYPE_PATTERN = /\bim\b|mpim|direct|dm\b|thread|user/;

export interface SlackChannelCatalogEntry {
  id: string;
  name?: string;
  teamName?: string;
}

type SlackChannelVerdict = 'channel' | 'excluded' | 'untyped';

function classifySlackChannelType(record: Record<string, unknown>): SlackChannelVerdict {
  if (record.is_im === true || record.isIm === true || record.is_mpim === true || record.isMpim === true) {
    return 'excluded';
  }
  if (record.is_archived === true || record.isArchived === true || record.archived === true) {
    return 'excluded';
  }
  // DM entries in mixed listings carry recipient/user fields instead of a channel name.
  if (record.recipient !== undefined || record.recipients !== undefined || record.user !== undefined) {
    return 'excluded';
  }
  if (record.is_channel === true || record.isChannel === true || record.is_group === true
    || record.isGroup === true || record.is_private === true || record.isPrivate === true) {
    return 'channel';
  }

  const typeValue = record.type ?? record.channelType ?? record.channel_type ?? record.kind;
  if (typeValue === undefined || typeValue === null) return 'untyped';
  const typeWord = readString(typeValue)?.toLowerCase();
  if (!typeWord) return 'untyped';
  if (EXCLUDED_TYPE_PATTERN.test(typeWord)) return 'excluded';
  if (CHANNEL_TYPE_WORDS.some((word) => typeWord.includes(word))) return 'channel';
  // Unknown explicit type: fail closed rather than offering a non-postable surface.
  return 'excluded';
}

function normalizeSlackChannelEntry(value: unknown): SlackChannelCatalogEntry | undefined {
  const record = readObject(value);
  if (!record) return undefined;
  const id = readEntryId(record);
  if (!id || !SAFE_SLACK_ID.test(id) || SLACK_DM_ID.test(id)) return undefined;
  if (classifySlackChannelType(record) === 'excluded') return undefined;

  const team = readObject(record.team) ?? readObject(record.workspace);
  const name = readEntryName(record);
  const teamName = readString(record.teamName) ?? readString(record.team_name)
    ?? readString(record.workspaceName) ?? readString(record.workspace_name)
    ?? readString(team?.name);
  return {
    id,
    ...(name ? { name } : {}),
    ...(teamName ? { teamName } : {}),
  };
}

export function parseSlackChannelListOutput(stdout: string): SlackChannelCatalogEntry[] {
  const arrays: unknown[][] = [];
  for (const candidate of parseJsonCandidates(stdout)) {
    collectChannelEntryArrays(candidate, 0, arrays);
  }
  const entries = new Map<string, SlackChannelCatalogEntry>();
  for (const array of arrays) {
    for (const item of array) {
      const entry = normalizeSlackChannelEntry(item);
      if (!entry) continue;
      const existing = entries.get(entry.id);
      // Prefer the entry that carries a human channel name.
      if (!existing || (!existing.name && entry.name)) entries.set(entry.id, entry);
    }
  }
  return [...entries.values()];
}

export function slackChannelDestinationLabel(entry: SlackChannelCatalogEntry): string {
  if (!entry.name) return `channel ${entry.id}`;
  return entry.name.startsWith('#') ? entry.name : `#${entry.name}`;
}

export function buildSlackChannelDestinations(
  entries: SlackChannelCatalogEntry[],
): NewSessionDestinationOption[] {
  return entries
    .map((entry): NewSessionDestinationOption => ({
      id: `slack:channel:${entry.id}`,
      target: `channel:${entry.id}`,
      label: slackChannelDestinationLabel(entry),
      ...(entry.teamName ? { group: entry.teamName } : {}),
    }))
    .sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.label.localeCompare(b.label));
}

export interface ListSlackChannelDestinationsOptions {
  execOpenClaw?: OpenClawExec;
}

// Returns [] when OpenClaw cannot provide a real channel catalog; the
// caller omits the Slack provider instead of falling back to
// recent-session rows as fake channels.
export async function listSlackChannelDestinations(
  options: ListSlackChannelDestinationsOptions = {},
): Promise<NewSessionDestinationOption[]> {
  const exec = options.execOpenClaw
    ?? ((command, args) => execFileAsync(command, args, { timeout: CHANNEL_LIST_TIMEOUT_MS, windowsHide: true }));
  try {
    const { stdout } = await exec('openclaw', ['message', 'channel', 'list', '--channel', 'slack', '--json']);
    return buildSlackChannelDestinations(parseSlackChannelListOutput(stdout));
  } catch {
    return [];
  }
}
