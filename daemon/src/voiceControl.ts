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
//   {"sessionId": "<uuid>", "gainDb": -6}      // TTS volume, absolute dB
//   {"sessionId": "<uuid>", "adjustDb": -3}    // TTS volume, relative step
//   {"sessionId": "<uuid>", "voiceId": "...", "gainDb": -6}  // both at once
//   {"sessionId": "<uuid>", "reset": true}     // back to daemon defaults
// sessionId optional: omitted -> apply to EVERY active voice room.
// Gain range: -30..+12 dB, 0 = neutral. Clamped; result echoed in the reply.
// Response: one JSON line, then close.
//   {"ok": true, "applied": 2}
//   {"ok": true, "applied": 1, "gainDb": -6}
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
      let cmd: { sessionId?: string; voiceId?: string; model?: string; reset?: boolean; gainDb?: number; adjustDb?: number };
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
      const hasGain = typeof cmd.gainDb === 'number';
      const hasAdjust = typeof cmd.adjustDb === 'number';
      if (!reset && !voiceId && !hasGain && !hasAdjust) {
        sock.end(JSON.stringify({ ok: false, error: 'missing_voice_id_or_gain' }) + '\n');
        return;
      }
      let ok = true;
      let applied = 0;
      let gainDb: number | undefined;
      const errors: string[] = [];
      if (voiceId || reset) {
        // Raw pass-through: no name lookup here — the caller owns the registry.
        const settings = reset
          ? {}
          : { tts: { providerId: 'elevenlabs', ...(model ? { model } : {}), voice: voiceId } };
        const vr = peer.applyVoiceSettings(sessionId, settings, reset);
        if (!vr.ok) errors.push('voice: ' + (vr.error ?? 'failed'));
        else applied = Math.max(applied, vr.applied ?? 0);
      }
      if (hasGain || hasAdjust) {
        const gr = peer.setTtsVolume(sessionId, {
          ...(typeof cmd.gainDb === 'number' ? { gainDb: cmd.gainDb } : {}),
          ...(typeof cmd.adjustDb === 'number' ? { adjustDb: cmd.adjustDb } : {}),
        });
        if (!gr.ok) errors.push('volume: ' + (gr.error ?? 'failed'));
        else {
          applied = Math.max(applied, gr.applied ?? 0);
          gainDb = gr.gainDb;
        }
      }
      ok = errors.length === 0;
      sock.end(JSON.stringify(
        ok
          ? { ok: true, applied, ...(gainDb !== undefined ? { gainDb } : {}) }
          : { ok: false, error: errors.join('; ') },
      ) + '\n');
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