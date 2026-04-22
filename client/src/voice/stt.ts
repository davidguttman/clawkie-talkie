// Streaming speech-to-text seam.
//
// This slice uses the browser's built-in Web Speech API for live
// transcription — the fastest working path to "see my voice" in the UI.
// The exported interface intentionally hides that detail so a later phase
// can swap in a daemon-backed or xAI-streaming transport without touching
// the driving state machine.

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function isSTTSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export interface STTHandlers {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (reason: string) => void;
}

export interface STTHandle {
  // Ask the underlying recognizer to finalize. onFinal will fire with the
  // full accumulated transcript before the handle settles.
  stop(): void;
  // Abort without publishing a final result.
  cancel(): void;
}

export function startBrowserSTT(handlers: STTHandlers): STTHandle {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    handlers.onError('stt_unsupported');
    return { stop: () => {}, cancel: () => {} };
  }

  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';

  // The recognizer emits partials and finals as separate result entries.
  // We accumulate finalized segments into `finalized` and append the live
  // tail so the UI reads as one continuous transcript.
  let finalized = '';
  let published = false;

  rec.onresult = (ev) => {
    let tail = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const text = r[0]?.transcript || '';
      if (r.isFinal) {
        finalized = (finalized ? finalized + ' ' : '') + text.trim();
      } else {
        tail += text;
      }
    }
    const combined = (finalized + ' ' + tail).trim();
    handlers.onPartial(combined);
  };

  rec.onerror = (ev) => {
    const reason = ev?.error || ev?.message || 'stt_failed';
    // `no-speech` / `aborted` are expected — treat as benign so the UI
    // doesn't route into an error state on a quiet recording.
    if (reason === 'no-speech' || reason === 'aborted') return;
    handlers.onError(String(reason));
  };

  rec.onend = () => {
    if (published) return;
    published = true;
    handlers.onFinal(finalized.trim());
  };

  try {
    rec.start();
  } catch (err) {
    handlers.onError(err instanceof Error ? err.message : 'stt_start_failed');
  }

  return {
    stop() {
      try {
        rec.stop();
      } catch {
        // already stopped
      }
    },
    cancel() {
      published = true;
      try {
        rec.abort();
      } catch {
        // already aborted
      }
    },
  };
}
