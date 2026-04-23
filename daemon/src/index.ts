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
// opens and the daemon proxies `ct-control` traffic into xAI streaming
// STT sessions.
//
// Signaling is PeerJS — no custom rendezvous service.

import { parseArgs } from 'node:util';
import { DaemonPeer } from './peer.js';
import { XaiSttSession } from './sttSession.js';

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
    openSttSession: (send) => {
      console.error('[daemon] opening xAI STT session');
      return new XaiSttSession(
        { apiKey: cli.xaiApiKey, language: cli.sttLanguage },
        {
          onReady: () => send(JSON.stringify({ t: 'stt.ready' })),
          onPartial: (text, isFinal) =>
            send(JSON.stringify({ t: 'stt.partial', text, is_final: isFinal })),
          onDone: (text) => send(JSON.stringify({ t: 'stt.done', text })),
          onError: (message) => send(JSON.stringify({ t: 'stt.error', message })),
          onClosed: () => send(JSON.stringify({ t: 'stt.closed' })),
        },
      );
    },
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
