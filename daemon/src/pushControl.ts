// Local push-audio control door — a Unix domain socket the daemon
// listens on so local processes (the agent, automations, scripts) can
// push unsolicited audio to a session's voice room without going
// through a chat turn.
//
// Wire: newline-terminated JSON per connection:
//   {"sessionId": "<uuid>", "file": "/abs/path.mp3", "label": "song"}
//   {"sessionId": "<uuid>", "text": "Hello from the daemon", "label": "greeting"}
// Response: one JSON line, then close.
//   {"ok": true, "notificationId": 3, "playedMs": 5211}
//   {"ok": false, "error": "no_client", "detail": "..."}
//
// Scope: loopback-only by construction (a Unix socket file with 0600
// under the user's runtime dir). No remote exposure.

import { createServer, type Socket } from 'node:net';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DaemonPeer } from './peer.js';

const DEFAULT_SOCKET_PATH = `${process.env.HOME ?? '/tmp'}/.clawkie-talkie/push.sock`;

export function startPushControl(peer: DaemonPeer, socketPath = process.env.CLAWKIE_PUSH_SOCKET ?? DEFAULT_SOCKET_PATH): void {
  try {
    mkdirSync(dirname(socketPath), { recursive: true });
    if (existsSync(socketPath)) rmSync(socketPath);
  } catch {
    console.error(`[push-control] cannot prepare socket dir: ${socketPath}`);
    return;
  }

  const server = createServer((sock: Socket) => {
    let buf = '';
    sock.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      let cmd: { sessionId?: string; file?: string; text?: string; label?: string };
      try {
        cmd = JSON.parse(line);
      } catch {
        sock.end(JSON.stringify({ ok: false, error: 'bad_json' }) + '\n');
        return;
      }
      const sessionId = (cmd.sessionId ?? '').trim();
      const file = (cmd.file ?? '').trim();
      const text = (cmd.text ?? '').trim();
      if (!sessionId || (!file && !text)) {
        sock.end(JSON.stringify({ ok: false, error: 'missing_session_or_file_or_text' }) + '\n');
        return;
      }
      const push = text
        ? peer.pushSpeech(sessionId, { text, ...(cmd.label ? { label: cmd.label } : {}) })
        : peer.pushAudioFile(sessionId, { file, ...(cmd.label ? { label: cmd.label } : {}) });
      void push
        .then((result) => {
          sock.end(JSON.stringify(result) + '\n');
        })
        .catch((err) => {
          sock.end(JSON.stringify({ ok: false, error: 'internal', detail: String(err) }) + '\n');
        });
    });
    sock.on('error', () => { /* client vanished — ignore */ });
  });

  server.listen(socketPath, () => {
    console.log(`[push-control] listening on ${socketPath}`);
  });
  server.on('error', (err) => {
    console.error(`[push-control] socket error: ${err.message}`);
  });
}