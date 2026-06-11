// Clawkie-Talkie daemon — single-session walking skeleton.
//
// Dev (one command from repo root): `npm run dev` — runs both this
// daemon and the Vite client. Defaults assume localhost:5173.
//
// Manual override:
//   npm run daemon -- --session-id <sid> --client-origin <url>
//
// The daemon subscribes to the hosted rambly-style signaling broker
// under a UUID token generated each session (or overridden via
// DAEMON_PEER_ID env). The phone discovers the daemon via
// `/dashboard/#host=<uuid>` for the host dashboard or `/voice#host=...&session=...`
// for a selected voice session. simple-peer + @roamhq/wrtc
// drive the WebRTC DataChannel; the daemon owns the full turn:
// OpenClaw infer transcription on inbound mic PCM, the configured
// OpenClaw agent on the final transcript, and OpenClaw infer TTS on
// the reply, with resulting PCM16 audio streamed back to the phone.
// All LLM/STT/TTS auth lives in OpenClaw's own configuration; the
// daemon does not hold provider API keys.

import { DaemonPeer } from './peer.js';
import { parseCli } from './cli.js';
import { formatDashboardJoinUrl } from './dashboardUrl.js';
import { defaultRecentSessionsCache } from './recentSessions.js';

async function main(): Promise<void> {
  const cli = parseCli();

  // Prime the host dashboard session picker immediately. Requests that arrive
  // while this first load is still running share the same in-flight refresh.
  void defaultRecentSessionsCache.refresh();

  const peer = new DaemonPeer({
    sttLanguage: cli.sttLanguage,
    peerId: cli.peerId,
    sessionId: cli.sessionId,
    threadId: cli.threadId,
    signalServer: cli.signalServer,
    iceServers: cli.iceServers,
    onReady: (peerId) => {
      const joinUrl = formatDashboardJoinUrl(cli.clientOrigin, peerId);
      console.log(`Session:  ${cli.sessionId}`);
      if (cli.threadId) {
        console.log(`Thread:   ${cli.threadId}`);
      }
      console.log(`Peer ID:  ${peerId}`);
      console.log(`Signal:   ${cli.signalServer}`);
      console.log(`Join URL: ${joinUrl}`);
      console.log('Waiting for phone…');
    },
    onFatalError: (err) => {
      console.error(`[daemon] fatal signaling error — shutting down: ${err.message}`);
      peer.close();
      process.exit(1);
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
