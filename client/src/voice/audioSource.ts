// Audio-source boundary for daemon STT.
//
// Splits "where does PCM come from" from "how does it get sent to the
// daemon". `sttDaemon.ts` drives a single AudioSource through the same
// real browser flow (RtcContext → startDaemonSTT → DataChannel → daemon
// → xAI STT → UI liveText). Production default is the mic. A
// deterministic source backed by a fetchable PCM/WAV fixture can replace
// it **without code edits** by appending `?audio-fixture=<url>` to the
// join URL. Selection happens in `selectAudioSource` and is the only
// place that reads that query param.

export interface AudioSource {
  readonly kind: 'mic' | 'fixture';
  // Prepare. Mic: acquire device and begin emitting frames immediately
  // (so leading audio isn't lost during session setup). Fixture: fetch
  // and decode but do NOT emit yet — emission is deferred to `resume()`
  // so deterministic audio is paced in real time from stt.ready, with
  // no startup burst into the xAI upstream.
  start(onFrame: (pcm: ArrayBuffer) => void): Promise<void>;
  // Signals that the STT session is ready. Fixture sources start
  // emitting here; mic sources ignore (they're already emitting).
  resume?(): void;
  stop(): Promise<void>;
}

const SAMPLE_RATE = 16000;
const MIC_BUFFER_SIZE = 4096;
const FIXTURE_FRAME_MS = 100;
const FIXTURE_FRAME_BYTES = Math.floor(
  (FIXTURE_FRAME_MS * SAMPLE_RATE * 2) / 1000,
);

export class MicPermissionError extends Error {
  constructor(cause?: unknown) {
    super('mic_denied');
    this.name = 'MicPermissionError';
    if (cause && cause instanceof Error) this.cause = cause;
  }
}

export function createMicAudioSource(): AudioSource {
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let sink: GainNode | null = null;

  return {
    kind: 'mic',
    async start(onFrame) {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('media_unsupported');
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
      } catch (err) {
        throw new MicPermissionError(err);
      }

      const AudioCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      audioCtx = new AudioCtor({ sampleRate: SAMPLE_RATE });
      if (audioCtx.state === 'suspended') {
        try {
          await audioCtx.resume();
        } catch {
          // non-fatal
        }
      }

      source = audioCtx.createMediaStreamSource(stream);
      processor = audioCtx.createScriptProcessor(MIC_BUFFER_SIZE, 1, 1);
      processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        onFrame(floatTo16BitPcm(input));
      };
      source.connect(processor);
      sink = audioCtx.createGain();
      sink.gain.value = 0;
      processor.connect(sink);
      sink.connect(audioCtx.destination);
    },
    async stop() {
      try {
        processor?.disconnect();
      } catch {
        // ignore
      }
      try {
        source?.disconnect();
      } catch {
        // ignore
      }
      try {
        sink?.disconnect();
      } catch {
        // ignore
      }
      if (stream) for (const t of stream.getTracks()) t.stop();
      try {
        await audioCtx?.close();
      } catch {
        // ignore
      }
      stream = null;
      audioCtx = null;
      source = null;
      processor = null;
      sink = null;
    },
  };
}

export function createFixtureAudioSource(url: string): AudioSource {
  let pcm: ArrayBuffer | null = null;
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let onFrameRef: ((pcm: ArrayBuffer) => void) | null = null;

  return {
    kind: 'fixture',
    async start(onFrame) {
      onFrameRef = onFrame;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`fixture_fetch_${resp.status}`);
      const buf = await resp.arrayBuffer();
      pcm = parseFixture(buf);
    },
    resume() {
      if (stopped || !pcm || !onFrameRef) return;
      const data = pcm;
      const cb = onFrameRef;
      let offset = 0;
      const emitOne = () => {
        if (stopped) return;
        if (offset >= data.byteLength) {
          // Fixture exhausted. Stop emitting — DO NOT fill the tail
          // with silence and DO NOT loop. Supervisor verified against
          // xAI directly that a silence tail after real speech causes
          // xAI to emit empty `transcript.partial` events that clobber
          // the live transcript and then finalize `transcript.done`
          // with text="". The session stays open; the driver's
          // stop() / stt.audio.done is what finalizes with real text.
          if (interval) {
            clearInterval(interval);
            interval = null;
          }
          return;
        }
        const end = Math.min(offset + FIXTURE_FRAME_BYTES, data.byteLength);
        cb(data.slice(offset, end));
        offset = end;
      };
      // setInterval's first tick is ~100 ms out; kick the first frame
      // immediately so xAI starts receiving audio right after stt.ready.
      emitOne();
      interval = setInterval(emitOne, FIXTURE_FRAME_MS);
    },
    async stop() {
      stopped = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      onFrameRef = null;
    },
  };
}

export function selectAudioSource(): AudioSource {
  if (typeof window === 'undefined') return createMicAudioSource();
  const params = new URLSearchParams(window.location.search);
  const fixture = params.get('audio-fixture');
  if (fixture) return createFixtureAudioSource(fixture);
  return createMicAudioSource();
}

export function isFixtureModeActive(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('audio-fixture');
}

// WAV parser: skip the RIFF/WAVE headers, return the contents of the
// `data` chunk as raw bytes. Assumes the caller has supplied a PCM16LE
// mono 16 kHz fixture — no resampling, no format validation beyond
// locating the data chunk. If the input doesn't start with RIFF we
// treat it as raw PCM16LE already.
function parseFixture(buffer: ArrayBuffer): ArrayBuffer {
  if (buffer.byteLength < 12) return buffer;
  const view = new DataView(buffer);
  const isRiff =
    view.getUint32(0, false) === 0x52494646 /* 'RIFF' */ &&
    view.getUint32(8, false) === 0x57415645; /* 'WAVE' */
  if (!isRiff) return buffer;
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 0x64617461 /* 'data' */) {
      return buffer.slice(offset + 8, offset + 8 + chunkSize);
    }
    offset += 8 + chunkSize;
  }
  throw new Error('no_data_chunk_in_wav');
}

function floatTo16BitPcm(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    let s = input[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}
