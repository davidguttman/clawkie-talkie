// Clawkie-Talkie daemon — single-session walking skeleton.
//
// Dev (one command from repo root): `npm run dev` — runs both this
// daemon and the Vite client. Defaults assume localhost:5173.
//
// Manual override:
//   XAI_API_KEY=... npm run daemon -- --session-id <sid> \
//     --client-origin <url>
//
// The daemon registers with the public PeerJS broker (peerjs.com),
// receives an assigned peer ID, and prints a join URL the phone can
// open. Once the phone calls `peer.connect(<id>)`, a DataConnection
// opens and the daemon drives the full turn server-side: xAI STT on
// inbound mic PCM, xAI chat on the final transcript, xAI TTS on the
// reply, with resulting PCM16 audio streamed back to the phone.
//
// Signaling is PeerJS — no custom rendezvous service.
// The browser never holds an xAI API key.

import { parseArgs } from 'node:util';
import { DaemonPeer } from './peer.js';

interface CliOptions {
  sessionId: string;
  clientOrigin: string;
  xaiApiKey: string;
  sttLanguage?: string;
}

function parseCli(): CliOptions {
  const { values } = parseArgs({
    options: {
      'session-id': { type: 'string' },
      'client-origin': { type: 'string' },
      'stt-language': { type: 'string' },
    },
  });

  const xaiApiKey = process.env.XAI_API_KEY?.trim();
  if (!xaiApiKey) {
    console.error('XAI_API_KEY env var is required');
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
  };
}

async function main(): Promise<void> {
  const cli = parseCli();

  const peer = new DaemonPeer({
    apiKey: cli.xaiApiKey,
    sttLanguage: cli.sttLanguage,
    onReady: (peerId) => {
      const joinQuery = new URLSearchParams({ screen: 'handoff', host: peerId });
      const joinUrl = `${cli.clientOrigin.replace(/\/$/, '')}/?${joinQuery.toString()}`;
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
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[daemon] fatal', err);
  process.exit(1);
});
