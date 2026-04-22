// xAI-backed text-to-speech.
//
// David requires xAI for audio synthesis — SpeechSynthesis fallback is
// gone. This module POSTs the reply text to xAI's TTS endpoint, receives
// MP3 bytes, and plays them via an HTMLAudioElement. The state machine
// consumes the same TTSHandle shape (done promise + stop()) so the
// daemon/WebRTC transport phase can replace this path without touching
// the driving loop.
//
// Endpoint (docs.x.ai/developers/model-capabilities/audio/text-to-speech):
//   POST https://api.x.ai/v1/tts
//   Authorization: Bearer <key>
//   Content-Type: application/json
//   Body: { text, language, voice_id?, output_format? }
//   Response: raw audio bytes — default codec is MP3 @ 24 kHz / 128 kbps.
//
// Voice defaults to `eve` (xAI docs default). Settings.voice is currently
// a browser-voice label ("Samantha (en-US)") left over from the prior
// SpeechSynthesis path; surfacing xAI voice pick to the UI is out of
// scope for this slice.

const XAI_TTS_ENDPOINT = 'https://api.x.ai/v1/tts';
const DEFAULT_VOICE_ID = 'eve';
const DEFAULT_LANGUAGE = 'en';

export interface TTSHandle {
  // Resolves when playback finishes, fails, or is stopped. On error the
  // `error` property is populated before the promise resolves so callers
  // can route the driving loop to the error surface.
  done: Promise<void>;
  stop(): void;
  // Read after `done` resolves. Undefined on clean completion.
  readonly error?: string;
}

export interface TTSOptions {
  rate?: number;
  voiceId?: string;
  language?: string;
}

export interface TTSStartOptions extends TTSOptions {
  apiKey: string;
}

export function speakWithXaiTTS(text: string, opts: TTSStartOptions): TTSHandle {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const state: {
    stopped: boolean;
    error?: string;
    audioEl: HTMLAudioElement | null;
    objectUrl: string | null;
  } = {
    stopped: false,
    audioEl: null,
    objectUrl: null,
  };

  const cleanup = () => {
    if (state.audioEl) {
      try {
        state.audioEl.pause();
      } catch {
        // already paused
      }
      state.audioEl.src = '';
      state.audioEl = null;
    }
    if (state.objectUrl) {
      try {
        URL.revokeObjectURL(state.objectUrl);
      } catch {
        // ignore
      }
      state.objectUrl = null;
    }
  };

  const finish = (err?: string) => {
    if (err && !state.error) state.error = err;
    cleanup();
    resolveDone();
  };

  const handle: TTSHandle = {
    done,
    stop() {
      if (state.stopped) return;
      state.stopped = true;
      controller.abort();
      finish();
    },
    get error() {
      return state.error;
    },
  };

  if (!opts.apiKey?.trim()) {
    state.error = 'missing_xai_api_key';
    resolveDone();
    return handle;
  }
  if (!text.trim()) {
    resolveDone();
    return handle;
  }

  const controller = new AbortController();

  (async () => {
    let res: Response;
    try {
      res = await fetch(XAI_TTS_ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          text,
          language: opts.language || DEFAULT_LANGUAGE,
          voice_id: opts.voiceId || DEFAULT_VOICE_ID,
        }),
      });
    } catch (err) {
      if (controller.signal.aborted) return finish();
      return finish(err instanceof Error ? err.message : 'xai_tts_fetch_failed');
    }

    if (state.stopped) return finish();
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      return finish(`xai_tts_http_${res.status}${detail ? ': ' + detail : ''}`);
    }

    let blob: Blob;
    try {
      blob = await res.blob();
    } catch (err) {
      return finish(err instanceof Error ? err.message : 'xai_tts_blob_failed');
    }
    if (state.stopped) return finish();
    if (!blob.size) return finish('xai_tts_empty_audio');

    const mime = blob.type || 'audio/mpeg';
    const typed = blob.type ? blob : new Blob([blob], { type: mime });
    state.objectUrl = URL.createObjectURL(typed);

    const audio = new Audio(state.objectUrl);
    state.audioEl = audio;
    if (opts.rate && Number.isFinite(opts.rate)) audio.playbackRate = opts.rate;

    audio.addEventListener('ended', () => finish());
    audio.addEventListener('error', () => {
      const code = audio.error?.code;
      finish(`audio_playback_failed${code ? '_' + code : ''}`);
    });

    try {
      await audio.play();
    } catch (err) {
      if (state.stopped) return finish();
      return finish(err instanceof Error ? `audio_play_rejected:${err.message}` : 'audio_play_rejected');
    }
  })();

  return handle;
}
