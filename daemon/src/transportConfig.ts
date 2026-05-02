import { DEFAULT_SIGNAL_SERVER } from './signalServer.js';

export function resolveSignalServer(
  cliValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return cliValue?.trim() || env.CT_SIGNAL_SERVER?.trim() || DEFAULT_SIGNAL_SERVER;
}

export function resolveIceServers(
  cliValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RTCIceServer[] | undefined {
  if (cliValue !== undefined) return parseIceServersJson(cliValue, '--ice-servers-json');
  if (env.CT_ICE_SERVERS_JSON !== undefined) {
    return parseIceServersJson(env.CT_ICE_SERVERS_JSON, 'CT_ICE_SERVERS_JSON');
  }
  return undefined;
}

export function parseIceServersJson(value: string, label: string): RTCIceServer[] {
  try {
    return normalizeIceServers(JSON.parse(value));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid ${label}: expected JSON array of RTCIceServer objects (${detail})`);
  }
}

function normalizeIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) throw new Error('top-level value is not an array');
  return value.map((entry, index) => normalizeIceServer(entry, index));
}

function normalizeIceServer(value: unknown, index: number): RTCIceServer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`entry ${index} is not an object`);
  }
  const source = value as Record<string, unknown>;
  const urls = normalizeUrls(source.urls, index);
  const out: RTCIceServer = { urls };
  if (source.username !== undefined) {
    if (typeof source.username !== 'string') throw new Error(`entry ${index}.username is not a string`);
    out.username = source.username;
  }
  if (source.credential !== undefined) {
    if (typeof source.credential !== 'string') throw new Error(`entry ${index}.credential is not a string`);
    out.credential = source.credential;
  }
  return out;
}

function normalizeUrls(value: unknown, index: number): string | string[] {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim())) {
    return value;
  }
  throw new Error(`entry ${index}.urls must be a non-empty string or string array`);
}
