// Parse handoff parameters from Clawkie-Talkie app URLs. Hash fragments are
// preferred so identifiers (host, session, routing metadata) are not transmitted to web
// servers; query params are accepted for compatibility. If a key is
// present in both, the hash wins.
//
// VITE_DEFAULT_HOST_ID sets a fallback hostPeerId when the URL has no host param.
// Useful for dev/worktree setups where the URL hash is not set per-instance.

export interface HandoffRoute {
  hostPeerId: string;
  sessionId: string;
  sessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
}

export interface HostDashboardRoute {
  hostPeerId: string;
}

function parseAppUrl(raw: string): { pathname: string; query: URLSearchParams; hash: URLSearchParams } | null {
  let url: URL;
  try {
    url = new URL(raw, 'https://clawkietalkie.app');
  } catch {
    return null;
  }

  const hashText = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  return { pathname: url.pathname, query: url.searchParams, hash: new URLSearchParams(hashText) };
}

const DEFAULT_HOST_ID =
  typeof import.meta.env.VITE_DEFAULT_HOST_ID === 'string' && import.meta.env.VITE_DEFAULT_HOST_ID.length > 0
    ? import.meta.env.VITE_DEFAULT_HOST_ID
    : '';

function readParam(parsed: { query: URLSearchParams; hash: URLSearchParams }, key: string): string {
  return parsed.hash.get(key) || parsed.query.get(key) || '';
}

function defaultHostId(raw: string): string {
  return raw.trim() || DEFAULT_HOST_ID;
}

export function parseHandoffUrl(raw: string): HandoffRoute | null {
  const parsed = parseAppUrl(raw);
  if (!parsed) return null;

  const pathname = parsed.pathname.replace(/\/$/, '') || '/';
  if (pathname !== '/voice') return null;

  const hostPeerId = defaultHostId(readParam(parsed, 'host'));
  const sessionId = readParam(parsed, 'session').trim();
  const sessionKey = readParam(parsed, 'sessionKey').trim();
  const channel = readParam(parsed, 'channel').trim();
  const target = readParam(parsed, 'target').trim();
  const accountId = readParam(parsed, 'accountId').trim() || readParam(parsed, 'account').trim();

  if (!hostPeerId || !sessionId) return null;

  return {
    hostPeerId,
    sessionId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(channel ? { channel } : {}),
    ...(target ? { target } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

export function parseHostDashboardUrl(raw: string): HostDashboardRoute | null {
  const parsed = parseAppUrl(raw);
  if (!parsed) return null;
  const pathname = parsed.pathname.replace(/\/$/, '') || '/';
  if (pathname !== '/dashboard' && pathname !== '/voice') return null;

  const hostPeerId = defaultHostId(readParam(parsed, 'host'));
  const sessionId = readParam(parsed, 'session').trim();
  if (!hostPeerId || sessionId) return null;

  return { hostPeerId };
}

export function formatHandoffHash(handoff: HandoffRoute): string {
  const params = new URLSearchParams();
  params.set('host', handoff.hostPeerId);
  params.set('session', handoff.sessionId);
  if (handoff.sessionKey) params.set('sessionKey', handoff.sessionKey);
  if (handoff.channel) params.set('channel', handoff.channel);
  if (handoff.target) params.set('target', handoff.target);
  if (handoff.accountId) params.set('accountId', handoff.accountId);
  return `#${params.toString()}`;
}

export function parseHandoffFromLocation(location: { search: string; hash: string }): HandoffRoute | null {
  const search = location.search || '';
  const hash = location.hash || '';
  return parseHandoffUrl('/voice' + search + hash);
}