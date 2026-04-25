import { randomUUID } from 'node:crypto';

export function resolveDaemonPeerId(env: NodeJS.ProcessEnv = process.env): string {
  return env.DAEMON_PEER_ID?.trim() || randomUUID();
}
