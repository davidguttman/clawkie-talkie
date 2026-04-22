// Text-to-speech seam.
//
// This slice plays the assistant reply via window.speechSynthesis so we
// get audible output instantly across browsers. A later phase can swap
// this implementation for xAI streaming TTS without touching callers —
// the TTSHandle contract (stop + done promise) is what the state machine
// depends on.

export interface TTSHandle {
  // Resolves when playback finishes naturally or is stopped.
  done: Promise<void>;
  // Abort playback; `done` resolves shortly after.
  stop(): void;
}

export interface TTSOptions {
  rate?: number;
  voiceName?: string;
}

export function speakWithBrowserTTS(text: string, opts: TTSOptions = {}): TTSHandle {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;

  if (!synth) {
    return { done: Promise.resolve(), stop: () => {} };
  }

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  try {
    synth.cancel();
  } catch {
    // no-op: nothing was speaking
  }

  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = opts.rate ?? 1.05;
  utter.pitch = 1;
  utter.volume = 1;

  const voices = synth.getVoices();
  const preferred =
    (opts.voiceName && voices.find((v) => v.name === opts.voiceName)) ||
    voices.find((v) => /samantha|serena|google us english|alex/i.test(v.name));
  if (preferred) utter.voice = preferred;

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    resolveDone();
  };

  utter.onend = finish;
  utter.onerror = finish;

  try {
    synth.speak(utter);
  } catch {
    finish();
  }

  return {
    done,
    stop() {
      try {
        synth.cancel();
      } catch {
        // ignore
      }
      finish();
    },
  };
}
