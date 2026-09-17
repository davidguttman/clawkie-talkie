// Push-audio notification channel — unsolicited audio to a connected
// voice room, outside the chat-turn lifecycle.
//
// Sources normalize to raw PCM + sample rate + a start/done frame pair,
// reusing the client's existing TTS playback path:
//   1. Local audio files (MP3/WAV/anything ffmpeg decodes) — this module
//   2. Generated speech (ElevenLabs text→speech) — later
//   3. Streaming URLs (radio) — later; needs a stop control first
//
// Rules (agreed 2026-09-17):
// - Notifications NEVER interrupt. If a turn is in flight or the mic is
//   hot (STT open), the push waits in the queue and plays when the room
//   goes quiet. A handset that talks over its human is broken.
// - Notifications are marked kind:'notification' + their own
//   notificationId on tts.start. The Pi saves them as notif-*.wav so
//   triple-tap replay plays the last interaction whatever it was —
//   a notification replays alone (no mic pairing), a turn replays
//   mic + TTS as before.
// - If no client is connected the push fails fast with 'no_client' —
//   notifications are ephemeral, not held for reconnect.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { daemonToPhone } from './protocol.js';
import type { VoiceSessionNotificationPort } from './voiceSessionPort.js';

export interface PushAudioRequest {
  /** Absolute path to a local audio file (decoded via ffmpeg). */
  file: string;
  /** Optional human label carried in tts.start.text. */
  label?: string;
}

export type PushAudioResult =
  | { ok: true; notificationId: number; playedMs: number }
  | { ok: false; error: 'no_client' | 'file_missing' | 'decode_failed' | 'send_failed'; detail?: string };

/** Target data-channel PCM rate the Pi client plays. */
const DATA_CHANNEL_RATE = 16_000;
/** 100 ms of mono PCM16 at the data-channel rate. */
const CHUNK_BYTES = (DATA_CHANNEL_RATE / 10) * 2;
/** How often the queue re-checks room quietness. */
const RETRY_MS = 1_500;

export class PushAudioChannel {
  private nextNotificationId = 1;
  private playing = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly queue: Array<{
    req: PushAudioRequest;
    port: VoiceSessionNotificationPort;
    resolve: (r: PushAudioResult) => void;
  }> = [];

  /**
   * Push a local audio file to the connected client. Resolves when the
   * file has been fully handed to the data channel; queues while the
   * room is busy (turn in flight or mic hot) so notifications never
   * interrupt. Fails fast only for no-client / bad-file / send errors.
   */
  pushFile(port: VoiceSessionNotificationPort, req: PushAudioRequest): Promise<PushAudioResult> {
    return new Promise((res) => {
      this.queue.push({ req, port, resolve: res });
      this.pump();
    });
  }

  close(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    for (const item of this.queue.splice(0)) {
      item.resolve({ ok: false, error: 'no_client', detail: 'session closing' });
    }
  }

  /** FIFO pump: stream the next push when idle, quiet, and connected. */
  private pump(): void {
    if (this.playing) return;
    const next = this.queue[0];
    if (!next) return;

    // Never interrupt: wait for the room to be quiet before starting.
    if (!next.port.isRoomQuiet()) {
      this.scheduleRetry();
      return;
    }
    if (!next.port.isConnected()) {
      this.queue.shift();
      next.resolve({ ok: false, error: 'no_client' });
      this.pump();
      return;
    }

    this.queue.shift();
    this.playing = true;
    void this.streamFile(next.req, next.port)
      .then((r) => next.resolve(r))
      .finally(() => {
        this.playing = false;
        this.pump();
      });
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, RETRY_MS);
    this.retryTimer.unref?.();
  }

  private async streamFile(req: PushAudioRequest, port: VoiceSessionNotificationPort): Promise<PushAudioResult> {
    const file = resolvePath(req.file);
    if (!existsSync(file)) {
      return { ok: false, error: 'file_missing', detail: file };
    }

    const notificationId = this.nextNotificationId++;
    const start = daemonToPhone.ttsStart(DATA_CHANNEL_RATE, {
      kind: 'notification',
      notificationId,
      text: req.label ?? basename(file),
    });
    if (!port.sendControl(start)) {
      return { ok: false, error: 'send_failed' };
    }

    // Decode + resample + mono + s16le, chunked to 100ms frames on stdout.
    const ffmpeg = spawn('ffmpeg', [
      '-v', 'error',
      '-i', file,
      '-ac', '1',
      '-ar', String(DATA_CHANNEL_RATE),
      '-f', 's16le',
      '-',
    ]);
    const startedAt = Date.now();

    return await new Promise<PushAudioResult>((res) => {
      let sent = 0;
      let pending = Buffer.alloc(0);
      let settled = false;
      const finish = (r: PushAudioResult) => {
        if (settled) return;
        settled = true;
        try { ffmpeg.kill('SIGKILL'); } catch { /* ignore */ }
        res(r);
      };
      ffmpeg.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= CHUNK_BYTES) {
          const frame = pending.subarray(0, CHUNK_BYTES);
          pending = pending.subarray(CHUNK_BYTES);
          if (!port.sendAudio(new Uint8Array(frame))) {
            finish({ ok: false, error: 'send_failed' });
            return;
          }
          sent += frame.length;
        }
      });
      ffmpeg.stderr?.on('data', (d: Buffer) => {
        const text = d.toString().trim();
        if (text) console.error(`[push-audio] ffmpeg: ${text}`);
      });
      ffmpeg.on('error', (err) => finish({ ok: false, error: 'decode_failed', detail: err.message }));
      ffmpeg.on('close', (code) => {
        if (settled) return;
        if (pending.length > 0) {
          // Tail frame, shorter than 100ms.
          if (!port.sendAudio(new Uint8Array(pending))) {
            finish({ ok: false, error: 'send_failed' });
            return;
          }
          sent += pending.length;
        }
        if (code !== 0 && sent === 0) {
          finish({ ok: false, error: 'decode_failed', detail: `ffmpeg exit ${code}` });
          return;
        }
        port.sendControl(daemonToPhone.ttsDone());
        finish({ ok: true, notificationId, playedMs: Date.now() - startedAt });
      });
    });
  }
}