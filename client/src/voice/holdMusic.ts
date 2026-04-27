const HOLD_MUSIC_TRACKS = [
  'Dial Tone Reverie.mp3',
  'Dockside Hold.mp3',
  'Looped Hold Tone.mp3',
  'Pixel Queue.mp3',
  'Rotary Hush.mp3',
  'Soft Hold Tone.mp3',
] as const;

const MUSIC_GAIN = 0.16;
const NOISE_GAIN = 0.008;
const MUSIC_HIGHPASS_HZ = 140;
const NOISE_HIGHPASS_HZ = 1800;
const NOISE_BUFFER_SECONDS = 2;

let sharedAudioCtx: AudioContext | null = null;

interface HoldMusicSession {
  audio: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  musicFilter: BiquadFilterNode;
  musicGain: GainNode;
  noiseSource: AudioBufferSourceNode;
  noiseFilter: BiquadFilterNode;
  noiseGain: GainNode;
  started: boolean;
  stopped: boolean;
  onMetadata: () => void;
}

export class HoldMusicController {
  private session: HoldMusicSession | null = null;

  unlock(): Promise<void> {
    const audioCtx = getSharedHoldAudioContext();
    if (!audioCtx) return Promise.resolve();
    playSilentUnlockPulse(audioCtx);
    return resumeAudioContext(audioCtx);
  }

  start(): void {
    this.stop();

    const audioCtx = getSharedHoldAudioContext();
    if (!audioCtx || typeof Audio === 'undefined') return;
    void resumeAudioContext(audioCtx);

    try {
      const audio = new Audio(pickHoldMusicUrl());
      audio.loop = true;
      audio.preload = 'auto';

      const source = audioCtx.createMediaElementSource(audio);
      const musicFilter = audioCtx.createBiquadFilter();
      const musicGain = audioCtx.createGain();
      const noiseSource = createNoiseSource(audioCtx);
      const noiseFilter = audioCtx.createBiquadFilter();
      const noiseGain = audioCtx.createGain();

      musicFilter.type = 'highpass';
      musicFilter.frequency.value = MUSIC_HIGHPASS_HZ;
      musicFilter.Q.value = 0.7;
      musicGain.gain.value = MUSIC_GAIN;

      noiseFilter.type = 'highpass';
      noiseFilter.frequency.value = NOISE_HIGHPASS_HZ;
      noiseFilter.Q.value = 0.4;
      noiseGain.gain.value = NOISE_GAIN;

      source.connect(musicFilter);
      musicFilter.connect(musicGain);
      musicGain.connect(audioCtx.destination);

      noiseSource.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(audioCtx.destination);

      const session: HoldMusicSession = {
        audio,
        source,
        musicFilter,
        musicGain,
        noiseSource,
        noiseFilter,
        noiseGain,
        started: false,
        stopped: false,
        onMetadata: () => {
          this.beginSession(session);
        },
      };
      this.session = session;

      if (hasKnownDuration(audio)) {
        this.beginSession(session);
      } else {
        audio.addEventListener('loadedmetadata', session.onMetadata);
        audio.addEventListener('durationchange', session.onMetadata);
        audio.load();
      }
    } catch {
      this.stop();
    }
  }

  stop(): void {
    const session = this.session;
    this.session = null;
    if (!session) return;
    session.stopped = true;

    try {
      session.audio.removeEventListener('loadedmetadata', session.onMetadata);
      session.audio.removeEventListener('durationchange', session.onMetadata);
      session.audio.pause();
      session.audio.removeAttribute('src');
      session.audio.load();
    } catch {
      // best-effort cleanup
    }

    try {
      session.noiseSource.stop();
    } catch {
      // already stopped or never started
    }

    for (const node of [
      session.source,
      session.musicFilter,
      session.musicGain,
      session.noiseSource,
      session.noiseFilter,
      session.noiseGain,
    ]) {
      try {
        node.disconnect();
      } catch {
        // already disconnected
      }
    }
  }

  private beginSession(session: HoldMusicSession): void {
    if (this.session !== session || session.stopped || session.started) return;
    if (!hasKnownDuration(session.audio)) return;

    session.started = true;
    session.audio.currentTime = pickRandomStartTime(session.audio.duration);
    session.noiseSource.start(0);
    void session.audio.play().catch(() => {
      this.stop();
    });
  }
}

export function pickHoldMusicUrl(random: () => number = Math.random): string {
  const index = Math.min(
    HOLD_MUSIC_TRACKS.length - 1,
    Math.floor(random() * HOLD_MUSIC_TRACKS.length),
  );
  return `/music/${encodeURIComponent(HOLD_MUSIC_TRACKS[index])}`;
}

export function pickRandomStartTime(duration: number, random: () => number = Math.random): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0.001;
  const fraction = 0.15 + random() * 0.35;
  return Math.max(0.001, Math.min(duration - 0.001, duration * fraction));
}

function hasKnownDuration(audio: HTMLAudioElement): boolean {
  return Number.isFinite(audio.duration) && audio.duration > 0;
}

function getSharedHoldAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (sharedAudioCtx && sharedAudioCtx.state !== 'closed') return sharedAudioCtx;
  const AudioCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return null;
  try {
    sharedAudioCtx = new AudioCtor();
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

function resumeAudioContext(audioCtx: AudioContext): Promise<void> {
  if (audioCtx.state === 'closed' || audioCtx.state === 'running') return Promise.resolve();
  return audioCtx.resume().then(
    () => undefined,
    () => undefined,
  );
}

function playSilentUnlockPulse(audioCtx: AudioContext): void {
  try {
    const buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate || 48000);
    const source = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(audioCtx.destination);
    source.onended = () => {
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        // already disconnected
      }
    };
    source.start(0);
  } catch {
    // Unlock is best-effort; the hold bed can fail silently.
  }
}

function createNoiseSource(audioCtx: AudioContext): AudioBufferSourceNode {
  const length = Math.max(1, Math.floor((audioCtx.sampleRate || 48000) * NOISE_BUFFER_SECONDS));
  const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate || 48000);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = (Math.random() * 2 - 1) * 0.45;
  }
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}
