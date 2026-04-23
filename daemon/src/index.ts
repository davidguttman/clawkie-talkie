// Clawkie-Talkie daemon — single-session walking skeleton.
//
// Usage:
//   XAI_API_KEY=... npm run daemon -- --session-id <sid> \
//     --rendezvous-url http://localhost:8787 \
//     --client-origin  https://clawkie-talkie--featbrowser-voice-loop.jump.sh
//
// The daemon mints a UUID token, registers it with the rendezvous,
// prints a join URL to stdout, and waits for the phone to connect. It
// answers the phone-initiated WebRTC offer and proxies `ct-control`
// traffic into xAI streaming STT sessions.

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { RendezvousClient } from './rendezvous.js';
import { DaemonPeer } from './rtc.js';
import { XaiSttSession } from './sttSession.js';

interface CliOptions {
  sessionId: string;
  rendezvousUrl: string;
  clientOrigin: string;
  xaiApiKey: string;
  sttLanguage?: string;
}

function parseCli(): CliOptions {
  const { values } = parseArgs({
    options: {
      'session-id': { type: 'string' },
      'rendezvous-url': { type: 'string' },
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
    sessionId: values['session-id'] || '(unset)',
    rendezvousUrl: values['rendezvous-url'] || process.env.CT_RENDEZVOUS_URL || 'http://localhost:8787',
    clientOrigin:
      values['client-origin'] ||
      process.env.CT_CLIENT_ORIGIN ||
      'https://clawkie-talkie--featbrowser-voice-loop.jump.sh',
    sttLanguage: values['stt-language'] || process.env.CT_STT_LANGUAGE,
    xaiApiKey,
  };
}

interface Signal {
  type: 'offer' | 'answer' | 'candidate';
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

async function main(): Promise<void> {
  const cli = parseCli();
  const token = randomUUID();
  const selfId = randomUUID();

  const rc = new RendezvousClient(cli.rendezvousUrl, token, selfId);

  rc.on('error', (err) => console.error('[rendezvous]', err.message));

  await rc.register();

  const peer = new DaemonPeer({
    onIceCandidate: (candidate) => {
      void rc.sendSignal({ type: 'candidate', candidate } satisfies Signal);
    },
    onConnectionStateChange: (s) => {
      console.error(`[daemon] peer connection state: ${s}`);
    },
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
  });

  rc.on('sse', async (msg: { event: string; data: { id?: string; from?: string; data?: unknown } }) => {
    const { event, data } = msg;
    if (event === 'assigned') {
      console.error(`[daemon] assigned id ${data?.id}`);
      return;
    }
    if (event === 'peer-joined' || event === 'peer-present') {
      console.error(`[daemon] phone peer ${event}: ${data?.id}`);
      return;
    }
    if (event === 'peer-left') {
      console.error(`[daemon] phone peer left: ${data?.id}`);
      return;
    }
    if (event === 'signal') {
      const sig = data?.data as Signal | undefined;
      if (!sig) return;
      if (sig.type === 'offer' && sig.sdp) {
        const answer = await peer.acceptOffer({ type: 'offer', sdp: sig.sdp });
        // Narrow explicitly: RTCSessionDescriptionInit.type includes
        // 'pranswer' / 'rollback' which aren't valid in our Signal union.
        // The answerer returns an 'answer' here, so we re-stamp it.
        const answerSignal: Signal = { type: 'answer', sdp: answer.sdp ?? '' };
        await rc.sendSignal(answerSignal);
      } else if (sig.type === 'candidate' && sig.candidate) {
        await peer.addIceCandidate(sig.candidate);
      }
    }
  });

  rc.subscribe();

  // Bake the rendezvous URL into the join URL so the phone client can
  // reach the same room without any build-time env setup on the client
  // side. Client falls back to VITE_CT_RENDEZVOUS_URL if this param is
  // absent.
  const joinQuery = new URLSearchParams({
    screen: 'handoff',
    join: token,
    rendezvous: cli.rendezvousUrl,
  });
  const joinUrl = `${cli.clientOrigin.replace(/\/$/, '')}/?${joinQuery.toString()}`;
  console.log(`Session:   ${cli.sessionId}`);
  console.log(`Rendezvous:${cli.rendezvousUrl}`);
  console.log(`Join URL:  ${joinUrl}`);
  console.log('Waiting for phone…');

  const shutdown = () => {
    rc.close();
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
