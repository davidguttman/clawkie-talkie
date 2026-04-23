// Clawkie-Talkie daemon — single-session walking skeleton.
//
// Dev (one command from repo root): `npm run dev` — runs both this
// daemon and the Vite client. Defaults assume localhost:5173.
//
// Manual override:
//   XAI_API_KEY=... npm run daemon -- --session-id <sid> \
//     --client-origin <url>
//
// The daemon starts a local PeerJS signaling server (see signaling.ts)
// and registers on it under a deterministic peer ID so the phone can
// dial in from the client's base URL — no printed join token needed.
// Once the phone calls `peer.connect(<id>)`, a DataConnection opens and
// the daemon drives the full turn server-side: xAI STT on inbound mic
// PCM, xAI chat on the final transcript, xAI TTS on the reply, with
// resulting PCM16 audio streamed back to the phone.
//
// Signaling is self-hosted PeerJS — the browser reaches the server via
// same-origin `/peerjs` (Vite proxies it in dev; jump.sh forwards it).
// The browser never holds an xAI API key.

import { parseArgs } from 'node:util';
import { DaemonPeer } from './peer.js';
import {
  DEFAULT_SIGNALING_PORT,
  SIGNALING_PATH,
  startSignalingServer,
} from './signaling.js';

// Deterministic peer ID so the browser can default to it when the URL
// doesn't carry `?host=…`. One daemon per deployment, one ID.
export const DAEMON_PEER_ID = 'ct-daemon';

interface CliOptions {
  sessionId: string;
  clientOrigin: string;
  xaiApiKey: string;
  sttLanguage?: string;
  signalingPort: number;
}

function parseCli(): CliOptions {
  const { values } = parseArgs({
    options: {
      'session-id': { type: 'string' },
      'client-origin': { type: 'string' },
      'stt-language': { type: 'string' },
      'signaling-port': { type: 'string' },
    },
  });

  const xaiApiKey = process.env.XAI_API_KEY?.trim();
  if (!xaiApiKey) {
    console.error('XAI_API_KEY env var is required');
    process.exit(2);
  }

  const signalingPortRaw =
    values['signaling-port'] || process.env.CT_SIGNALING_PORT;
  const signalingPort = signalingPortRaw
    ? Number(signalingPortRaw)
    : DEFAULT_SIGNALING_PORT;
  if (!Number.isFinite(signalingPort) || signalingPort <= 0) {
    console.error(`Invalid signaling port: ${signalingPortRaw}`);
    process.exit(2);
  }

  return {
    sessionId: values['session-id'] || 'dev-local',
    clientOrigin:
      values['client-origin'] ||
      process.env.CT_CLIENT_ORIGIN ||
      'http://localhost:5173',
    sttLanguage: values['stt-language'] || process.env.CT_STT_LANGUAGE,
    xaiApiKey,
    signalingPort,
  };
}

async function main(): Promise<void> {
  const cli = parseCli();

  const signaling = await startSignalingServer(cli.signalingPort);
  console.error(
    `[signaling] listening on 127.0.0.1:${signaling.port}${signaling.path}`,
  );

  const peer = new DaemonPeer({
    apiKey: cli.xaiApiKey,
    sttLanguage: cli.sttLanguage,
    peerId: DAEMON_PEER_ID,
    signalingHost: '127.0.0.1',
    signalingPort: signaling.port,
    signalingPath: SIGNALING_PATH,
    onReady: (peerId) => {
      const joinUrl = cli.clientOrigin.replace(/\/$/, '') + '/';
      console.log(`Session:  ${cli.sessionId}`);
      console.log(`Peer ID:  ${peerId}`);
      console.log(`Join URL: ${joinUrl}`);
      console.log('Waiting for phone…');
    },
    onFatalError: (err) => {
      if (
        err.message.includes('network') ||
        err.message.includes('browser-incompatible') ||
        err.message.includes('server-error')
      ) {
        console.error('[daemon] fatal PeerJS error — shutting down');
        peer.close();
        process.exit(1);
      }
    },
  });

  const shutdown = () => {
    peer.close();
    void signaling.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[daemon] fatal', err);
  process.exit(1);
});
