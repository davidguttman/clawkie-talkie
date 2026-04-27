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

export const SAMPLE_RATE = 16000;
export const MIC_BUFFER_SIZE = 1024;
export const MIC_FRAME_DURATION_MS = (MIC_BUFFER_SIZE / SAMPLE_RATE) * 1000;
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

// Module-level mic resources, held across PTT cycles. iOS / Safari
// re-prompts for microphone access if the underlying MediaStream tracks
// are stopped between turns; we therefore acquire once and reuse the
// same stream + AudioContext + MediaStreamAudioSourceNode for every
// subsequent press. Only the per-turn `ScriptProcessorNode` (and its
// silent sink) is created and torn down on each start/stop.
let cachedStream: MediaStream | null = null;
let cachedAudioCtx: AudioContext | null = null;
let cachedSourceNode: MediaStreamAudioSourceNode | null = null;
let cachedSourceCtx: AudioContext | null = null;
let cachedMicAnalyser: AnalyserNode | null = null;
let cachedAnalyserSink: GainNode | null = null;
let cachedAnalyserCtx: AudioContext | null = null;

async function acquireMicResources(): Promise<{
  stream: MediaStream;
  audioCtx: AudioContext;
  source: MediaStreamAudioSourceNode;
}> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('media_unsupported');
  }

  if (cachedStream && cachedStream.getTracks().every((t) => t.readyState === 'live')) {
    // Stream is still alive — reuse it. Recreate the audio context if
    // it was closed (browsers can shut down inactive contexts).
    if (!cachedAudioCtx || cachedAudioCtx.state === 'closed') {
      const AudioCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      disconnectCachedMicAnalyser();
      cachedAudioCtx = new AudioCtor({ sampleRate: SAMPLE_RATE });
      cachedSourceNode = null;
      cachedSourceCtx = null;
    }
    if (cachedAudioCtx.state === 'suspended') {
      try {
        await cachedAudioCtx.resume();
      } catch {
        // non-fatal
      }
    }
    if (!cachedSourceNode || cachedSourceCtx !== cachedAudioCtx) {
      disconnectCachedMicAnalyser();
      cachedSourceNode = cachedAudioCtx.createMediaStreamSource(cachedStream);
      cachedSourceCtx = cachedAudioCtx;
    }
    ensureMicAnalyser(cachedAudioCtx, cachedSourceNode);
    return { stream: cachedStream, audioCtx: cachedAudioCtx, source: cachedSourceNode };
  }

  // Fresh acquisition (first PTT, or tracks died and need re-asking).
  disconnectCachedMicAnalyser();
  let stream: MediaStream;
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
  const audioCtx = new AudioCtor({ sampleRate: SAMPLE_RATE });
  if (audioCtx.state === 'suspended') {
    try {
      await audioCtx.resume();
    } catch {
      // non-fatal
    }
  }
  const source = audioCtx.createMediaStreamSource(stream);
  cachedStream = stream;
  cachedAudioCtx = audioCtx;
  cachedSourceNode = source;
  cachedSourceCtx = audioCtx;
  ensureMicAnalyser(audioCtx, source);
  return { stream, audioCtx, source };
}

function ensureMicAnalyser(
  audioCtx: AudioContext,
  source: MediaStreamAudioSourceNode,
): AnalyserNode {
  if (cachedMicAnalyser && cachedAnalyserCtx === audioCtx) return cachedMicAnalyser;

  disconnectCachedMicAnalyser();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0;
  const sink = audioCtx.createGain();
  sink.gain.value = 0;
  source.connect(analyser);
  analyser.connect(sink);
  sink.connect(audioCtx.destination);
  cachedMicAnalyser = analyser;
  cachedAnalyserSink = sink;
  cachedAnalyserCtx = audioCtx;
  return analyser;
}

function disconnectCachedMicAnalyser(): void {
  try {
    cachedMicAnalyser?.disconnect();
  } catch {
    // ignore
  }
  try {
    cachedAnalyserSink?.disconnect();
  } catch {
    // ignore
  }
  cachedMicAnalyser = null;
  cachedAnalyserSink = null;
  cachedAnalyserCtx = null;
}

export function getActiveMicAnalyser(): AnalyserNode | null {
  if (!cachedMicAnalyser || !cachedAudioCtx || cachedAudioCtx.state === 'closed') return null;
  if (!cachedStream || !cachedStream.getTracks().every((t) => t.readyState === 'live')) return null;
  return cachedMicAnalyser;
}

// Deliberate teardown for app unmount / cancel. Stops the underlying
// mic tracks, which is what triggers the "permission released"
// indicator on mobile. Safe to call repeatedly.
export async function releaseMicAudioSource(): Promise<void> {
  const stream = cachedStream;
  const audioCtx = cachedAudioCtx;
  const source = cachedSourceNode;
  cachedStream = null;
  cachedAudioCtx = null;
  cachedSourceNode = null;
  cachedSourceCtx = null;
  disconnectCachedMicAnalyser();
  try {
    source?.disconnect();
  } catch {
    // ignore
  }
  if (stream) {
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {
        // ignore
      }
    }
  }
  try {
    await audioCtx?.close();
  } catch {
    // ignore
  }
}

// Test seam: reset module-level cache without touching the DOM. Used
// by unit tests to start each scenario from a known-clean state.
export function _resetMicAudioSourceForTests(): void {
  cachedStream = null;
  cachedAudioCtx = null;
  cachedSourceNode = null;
  cachedSourceCtx = null;
  disconnectCachedMicAnalyser();
}

export function createMicAudioSource(): AudioSource {
  let processor: ScriptProcessorNode | null = null;
  let sink: GainNode | null = null;
  let connectedSource: MediaStreamAudioSourceNode | null = null;

  return {
    kind: 'mic',
    async start(onFrame) {
      const { audioCtx, source } = await acquireMicResources();

      processor = audioCtx.createScriptProcessor(MIC_BUFFER_SIZE, 1, 1);
      processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        onFrame(floatTo16BitPcm(input));
      };
      source.connect(processor);
      connectedSource = source;
      sink = audioCtx.createGain();
      sink.gain.value = 0;
      processor.connect(sink);
      sink.connect(audioCtx.destination);
    },
    async stop() {
      // Disconnect only the per-turn nodes. Leave the cached mic
      // stream + AudioContext + MediaStreamAudioSourceNode alive so
      // the next PTT does not re-prompt for mic permission.
      try {
        if (connectedSource && processor) connectedSource.disconnect(processor);
      } catch {
        // ignore
      }
      try {
        processor?.disconnect();
      } catch {
        // ignore
      }
      try {
        sink?.disconnect();
      } catch {
        // ignore
      }
      processor = null;
      sink = null;
      connectedSource = null;
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
export function parseFixture(buffer: ArrayBuffer): ArrayBuffer {
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

export function floatTo16BitPcm(input: Float32Array): ArrayBuffer {
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
