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
import { ElevenLabsTtsSession } from './elevenLabsTtsSession.js';
import type { VoiceSessionNotificationPort } from './voiceSessionPort.js';

export interface PushAudioRequest {
  /** Absolute path to a local audio file (decoded via ffmpeg). */
  file: string;
  /** Optional human label carried in tts.start.text. */
  label?: string;
}

export interface PushStreamRequest {
  /** HTTP(S) URL of an audio stream (radio, playlist, anything ffmpeg reads). */
  url: string;
  /** Optional label carried in tts.start.text. */
  label?: string;
  /** Playback gain 0..1 (ffmpeg volume filter). Streams default to 0.3 —
   * they decode at full line level and otherwise blast vs TTS speech. */
  volume?: number;
}

export interface PushSpeechRequest {
  /** Text to speak (generated via the streaming ElevenLabs path, 16kHz). */
  text: string;
  /** Optional label carried in tts.start.text (defaults to a text excerpt). */
  label?: string;
}

export type PushAudioResult =
  | { ok: true; notificationId: number; playedMs: number }
  | { ok: false; error: 'no_client' | 'file_missing' | 'decode_failed' | 'send_failed' | 'speech_failed' | 'stream_failed' | 'stopped'; detail?: string };

/** Target data-channel PCM rate the Pi client plays. */
const DATA_CHANNEL_RATE = 16_000;
/** 100 ms of mono PCM16 at the data-channel rate. */
const CHUNK_BYTES = (DATA_CHANNEL_RATE / 10) * 2;
/** Hard cap for streaming-URL notifications — they have no natural end. */
const PUSH_STREAM_MAX_MS = 30 * 60 * 1000;
/** Default gain for streaming pushes (0..1). Radio decodes at full line
 * level; linear 0.3 still read as "way too loud" against TTS speech in
 * field testing (2026-09-17): continuous music energy dominates even when
 * LUFS-measured below speech (radio -20 LUFS vs speech -17.4 at 0.3).
 * 0.15 puts streams at true background level; per-push volume overrides. */
const DEFAULT_STREAM_VOLUME = 0.15;
/** How often the queue re-checks room quietness. */
const RETRY_MS = 1_500;

export class PushAudioChannel {
  private nextNotificationId = 1;
  private playing = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private activeSpeechSession: ElevenLabsTtsSession | null = null;
  private queue: Array<{
    req: PushAudioRequest | PushSpeechRequest | PushStreamRequest;
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

  /**
   * Stream a live audio URL (radio etc.) as a notification. The stream has
   * no natural end — it plays until the 30-minute cap or a stop control.
   */
  pushStream(port: VoiceSessionNotificationPort, req: PushStreamRequest): Promise<PushAudioResult> {
    return new Promise((res) => {
      this.queue.push({ req, port, resolve: res });
      this.pump();
    });
  }

  /**
   * Speak text as an unsolicited notification via the streaming ElevenLabs
   * path (16kHz PCM — matches the data-channel rate, no resampling).
   * Same never-interrupt queue rules as file pushes.
   */
  pushSpeech(port: VoiceSessionNotificationPort, req: PushSpeechRequest): Promise<PushAudioResult> {
    return new Promise((res) => {
      this.queue.push({ req, port, resolve: res });
      this.pump();
    });
  }

  close(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    try { this.activeSpeechSession?.cancel(); } catch { /* ignore */ }
    this.activeSpeechSession = null;
    try { this.activeStreamProc?.kill('SIGKILL'); } catch { /* ignore */ }
    this.activeStreamProc = null;
    this.stopActive = null;
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
    const run = 'file' in next.req
      ? this.streamFile(next.req as PushAudioRequest, next.port)
      : 'text' in next.req
        ? this.streamSpeech(next.req as PushSpeechRequest, next.port)
        : this.streamUrl(next.req as PushStreamRequest, next.port);
    void run
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

  /**
   * Stop the in-flight push, any source. Returns true when something was
   * playing. Callers: client tap-stop (push.stop), PTT mic-priority
   * (stt.start cuts a playing notification — the human is about to talk),
   * and the control door's stop command (agreed 2026-09-17).
   */
  requestStop(): boolean {
    if (!this.playing) return false;
    this.stopActive?.();
    return true;
  }

  /** Source-specific stop for the in-flight push: kill decoder, close the client stream, resolve 'stopped'. */
  private stopActive: (() => void) | null = null;

  private activeStreamProc: import('node:child_process').ChildProcess | null = null;

  /**
   * Live audio URL source: ffmpeg reads the network stream, resamples to
   * 16k mono s16le, chunks to 100ms frames. Streams have no natural end —
   * playback runs until the 30-minute cap (PUSH_STREAM_MAX_MS) or a stop.
   */
  private async streamUrl(req: PushStreamRequest, port: VoiceSessionNotificationPort): Promise<PushAudioResult> {
    const url = req.url.trim();
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'stream_failed', detail: 'not an http(s) URL' };
    }
    const volume = typeof req.volume === 'number' && req.volume > 0 && req.volume <= 1 ? req.volume : DEFAULT_STREAM_VOLUME;

    const notificationId = this.nextNotificationId++;
    const start = daemonToPhone.ttsStart(DATA_CHANNEL_RATE, {
      kind: 'notification',
      notificationId,
      text: req.label ?? url,
      // Live streams are ephemeral radio — do not record them on the
      // client (a 30-min dump is pointless storage burn, and a live
      // broadcast is not replayable) — agreed 2026-09-17.
      noRecord: true,
    });
    if (!port.sendControl(start)) {
      return { ok: false, error: 'send_failed' };
    }

    const startedAt = Date.now();
    const ffmpeg = spawn('ffmpeg', [
      '-v', 'error',
      // Network sources can start mid-word or in silence; a little lead-in
      // lets the encoder settle and gives the client its jitter cushion.
      '-re',
      '-i', url,
      // Gain: streams decode at full line level — tame them to a level
      // comparable to TTS speech unless the push overrides it.
      '-af', `volume=${volume}`,
      '-ac', '1',
      '-ar', String(DATA_CHANNEL_RATE),
      '-f', 's16le',
      '-',
    ]);
    this.activeStreamProc = ffmpeg;

    // 30-minute hard cap — a stream has no natural end (agreed 2026-09-17).
    const capTimer = setTimeout(() => { try { ffmpeg.kill('SIGTERM'); } catch { /* ignore */ } }, PUSH_STREAM_MAX_MS);
    capTimer.unref?.();

    return await new Promise<PushAudioResult>((res) => {
      let sent = 0;
      let pending = Buffer.alloc(0);
      let settled = false;
      const finish = (r: PushAudioResult) => {
        if (settled) return;
        settled = true;
        this.stopActive = null;
        clearTimeout(capTimer);
        this.activeStreamProc = null;
        try { ffmpeg.kill('SIGKILL'); } catch { /* ignore */ }
        res(r);
      };
      this.stopActive = () => {
        try { ffmpeg.kill('SIGKILL'); } catch { /* ignore */ }
        port.sendControl(daemonToPhone.ttsDone());
        finish({ ok: false, error: 'stopped' });
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
        if (text) console.error(`[push-audio] ffmpeg(stream): ${text}`);
      });
      ffmpeg.on('error', (err) => {
        if (settled) return;
        if (sent === 0) {
          finish({ ok: false, error: 'stream_failed', detail: err.message });
        } else {
          port.sendControl(daemonToPhone.ttsDone());
          finish({ ok: true, notificationId, playedMs: Date.now() - startedAt });
        }
      });
      ffmpeg.on('close', (code) => {
        if (settled) return;
        if (pending.length > 0) {
          if (!port.sendAudio(new Uint8Array(pending))) {
            finish({ ok: false, error: 'send_failed' });
            return;
          }
          sent += pending.length;
        }
        if (code !== 0 && sent === 0) {
          finish({ ok: false, error: 'stream_failed', detail: `ffmpeg exit ${code}` });
          return;
        }
        port.sendControl(daemonToPhone.ttsDone());
        finish({ ok: true, notificationId, playedMs: Date.now() - startedAt });
      });
    });
  }

  /**
   * Speak text over the notification wire: streaming ElevenLabs session
   * (44.1k→16k in-session) → 100ms frames → existing TTS wire path.
   */
  private async streamSpeech(req: PushSpeechRequest, port: VoiceSessionNotificationPort): Promise<PushAudioResult> {
    const text = req.text.trim();
    if (!text) {
      return { ok: false, error: 'speech_failed', detail: 'empty text' };
    }

    const notificationId = this.nextNotificationId++;
    const start = daemonToPhone.ttsStart(DATA_CHANNEL_RATE, {
      kind: 'notification',
      notificationId,
      text: req.label ?? text.slice(0, 80),
    });
    if (!port.sendControl(start)) {
      return { ok: false, error: 'send_failed' };
    }

    const startedAt = Date.now();
    return await new Promise<PushAudioResult>((res) => {
      let sent = 0;
      let settled = false;
      const finish = (r: PushAudioResult) => {
        if (settled) return;
        settled = true;
        this.stopActive = null;
        res(r);
      };
      const session = new ElevenLabsTtsSession({ text }, {
        onAudio: (pcm) => {
          if (settled) return;
          if (!port.sendAudio(pcm)) {
            finish({ ok: false, error: 'send_failed' });
            return;
          }
          sent += pcm.byteLength;
        },
        onDone: () => {
          if (settled) return;
          port.sendControl(daemonToPhone.ttsDone());
          finish({ ok: true, notificationId, playedMs: Date.now() - startedAt });
        },
        onError: (message) => {
          if (settled) return;
          // No audio went out yet — abort cleanly with tts.done so the
          // client's playback state resets, then report the failure.
          if (sent === 0) {
            port.sendControl(daemonToPhone.ttsDone());
            finish({ ok: false, error: 'speech_failed', detail: message });
            return;
          }
          // Partial audio played — close the stream so the client drains;
          // report success since audio was delivered.
          port.sendControl(daemonToPhone.ttsDone());
          finish({ ok: true, notificationId, playedMs: Date.now() - startedAt });
        },
      });
      this.activeSpeechSession = session;
      this.stopActive = () => {
        try { session.cancel(); } catch { /* ignore */ }
        port.sendControl(daemonToPhone.ttsDone());
        finish({ ok: false, error: 'stopped' });
      };
    });
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
        this.stopActive = null;
        try { ffmpeg.kill('SIGKILL'); } catch { /* ignore */ }
        res(r);
      };
      this.stopActive = () => {
        try { ffmpeg.kill('SIGKILL'); } catch { /* ignore */ }
        port.sendControl(daemonToPhone.ttsDone());
        finish({ ok: false, error: 'stopped' });
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