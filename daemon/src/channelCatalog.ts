// Shared defensive parsing for OpenClaw channel-catalog CLI output.
//
// `openclaw message channel list --json` output shapes vary across
// OpenClaw versions and providers: a bare array, `{channels: [...]}`,
// or arrays nested under `data`/`result`/`payload`, sometimes preceded
// by log lines. The helpers here search the parsed JSON for arrays of
// channel-shaped entries instead of pinning one wrapper shape — the
// same approach newSession.ts takes for thread-create output. Provider
// modules (discordChannels.ts, slackChannels.ts) layer their own
// type/DM filtering on top.

export type OpenClawExec = (command: string, args: string[]) => Promise<{ stdout: string }>;

export function parseJsonCandidates(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    return [JSON.parse(trimmed)];
  } catch {
    // The CLI may prepend log lines; fall back to per-line parsing.
  }
  const candidates: unknown[] = [];
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      candidates.push(JSON.parse(candidate));
    } catch {
      // skip non-JSON lines
    }
  }
  return candidates;
}

export function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function readId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return readString(value);
}

export function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function looksLikeChannelEntry(value: unknown): boolean {
  const record = readObject(value);
  if (!record) return false;
  return readId(record.id) !== undefined
    || readId(record.channelId) !== undefined
    || readId(record.channel_id) !== undefined;
}

export function collectChannelEntryArrays(value: unknown, depth: number, out: unknown[][]): void {
  if (depth > 6 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (value.some(looksLikeChannelEntry)) {
      out.push(value);
      return;
    }
    for (const item of value) collectChannelEntryArrays(item, depth + 1, out);
    return;
  }
  for (const entry of Object.values(value)) collectChannelEntryArrays(entry, depth + 1, out);
}

export function readEntryId(record: Record<string, unknown>): string | undefined {
  return readId(record.id) ?? readId(record.channelId) ?? readId(record.channel_id);
}

export function readEntryName(record: Record<string, unknown>): string | undefined {
  return readString(record.name) ?? readString(record.channelName) ?? readString(record.channel_name);
}
