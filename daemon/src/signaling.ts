// Self-hosted PeerJS signaling server. Runs inside the daemon process so
// the stack doesn't depend on the public PeerJS broker (peerjs.com),
// which is unreachable from jump.sh containers. Both the daemon's Peer
// client and the browser client point at this server — the daemon via
// localhost, the browser via same-origin through the Vite proxy.

import type { Server as HttpServer } from 'node:http';
import { PeerServer } from 'peer';

export const SIGNALING_PATH = '/peerjs';
export const DEFAULT_SIGNALING_PORT = 9000;

export interface SignalingServer {
  readonly port: number;
  readonly path: string;
  close(): Promise<void>;
}

export function startSignalingServer(port = DEFAULT_SIGNALING_PORT): Promise<SignalingServer> {
  return new Promise((resolve) => {
    PeerServer(
      {
        port,
        path: SIGNALING_PATH,
        // Bind to loopback — only reached via the Vite proxy (dev) or
        // the same process (daemon).
        host: '127.0.0.1',
        allow_discovery: false,
      },
      (server: HttpServer) => {
        resolve({
          port,
          path: SIGNALING_PATH,
          close: () =>
            new Promise<void>((res) => {
              server.close(() => res());
            }),
        });
      },
    );
  });
}
