// Local voice control door — a Unix domain socket the daemon listens on
// so local processes (the agent, scripts) can change the TTS voice of a
// session's voice rooms LIVE, without a restart or re-rendezvous.
//
// Division of work (agreed 2026-09-25): the daemon takes RAW ids only —
// the ElevenLabs voice id and model — and holds no name-lookup registry.
// Whoever talks to this socket does the lookup (e.g. the panel
// voice-registry on the agent side).
//
// Wire: newline-terminated JSON per connection:
//   {"sessionId": "<uuid>", "voiceId": "<raw-id>", "model": "eleven_v3"}
//   {"sessionId": "<uuid>", "reset": true}     // back to daemon defaults
// sessionId optional: omitted -> apply to EVERY active voice room.
// Response: one JSON line, then close.
//   {"ok": true, "applied": 2}
//   {"ok": false, "error": "no_client", "detail": "..."}
//
// Scope: loopback-only by construction (a Unix socket file with 0600
// under the user's runtime dir). No remote exposure.

import { createServer, type Socket } from 'node:net';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DaemonPeer } from './peer.js';

const DEFAULT_SOCKET_PATH = (process.env.HOME ?? '/tmp') + '/.clawkie-talkie/voice.sock';

export function startVoiceControl(peer: DaemonPeer, socketPath = process.env.CLAWKIE_VOICE_SOCKET ?? DEFAULT_SOCKET_PATH): void {
  try {
    mkdirSync(dirname(socketPath), { recursive: true });
    if (existsSync(socketPath)) rmSync(socketPath);
  } catch {
    console.error('[voice-control] cannot prepare socket dir: ' + socketPath);
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
      let cmd: { sessionId?: string; voiceId?: string; model?: string; reset?: boolean };
      try {
        cmd = JSON.parse(line);
      } catch {
        sock.end(JSON.stringify({ ok: false, error: 'bad_json' }) + '\n');
        return;
      }
      const sessionId = (cmd.sessionId ?? '').trim();
      const voiceId = (cmd.voiceId ?? '').trim();
      const model = (cmd.model ?? '').trim();
      const reset = cmd.reset === true;
      if (!reset && !voiceId) {
        sock.end(JSON.stringify({ ok: false, error: 'missing_voice_id' }) + '\n');
        return;
      }
      // Raw pass-through: no name lookup here — the caller owns the registry.
      const settings = reset
        ? {}
        : { tts: { providerId: 'elevenlabs', ...(model ? { model } : {}), voice: voiceId } };
      const result = peer.applyVoiceSettings(sessionId, settings);
      sock.end(JSON.stringify(result) + '\n');
    });
    sock.on('error', () => { /* client hung up — nothing to do */ });
  });

  server.listen(socketPath, () => {
    console.log('[voice-control] listening on ' + socketPath);
  });
  server.on('error', (err: Error) => {
    console.error('[voice-control] socket error: ' + err.message);
  });
}