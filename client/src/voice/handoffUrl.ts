// Parse handoff parameters from a `/voice` URL. Hash fragments are
// preferred so identifiers (host, session, channel, target) are not
// transmitted to web servers; query params are accepted for
// compatibility. If a key is present in both, the hash wins.

export interface HandoffRoute {
  hostPeerId: string;
  sessionId: string;
  delivery: {
    channel: string;
    target?: string;
  };
}

export function parseHandoffUrl(raw: string): HandoffRoute | null {
  let url: URL;
  try {
    url = new URL(raw, 'https://clawkietalkie.app');
  } catch {
    return null;
  }
  const query = url.searchParams;
  const hashText = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const hash = new URLSearchParams(hashText);

  const get = (key: string) => hash.get(key) || query.get(key) || '';
  const hostPeerId = get('host').trim();
  const sessionId = get('session').trim();
  const channel = get('channel').trim();
  const target = get('target').trim();

  if (!hostPeerId || !sessionId || !channel) return null;

  const delivery = channel === 'webchat'
    ? { channel }
    : target
      ? { channel, target }
      : null;

  if (delivery === null) return null;

  return {
    hostPeerId,
    sessionId,
    delivery,
  };
}

export function parseHandoffFromLocation(location: { search: string; hash: string }): HandoffRoute | null {
  const search = location.search || '';
  const hash = location.hash || '';
  return parseHandoffUrl('/voice' + search + hash);
}
