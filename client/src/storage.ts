// localStorage-backed settings persistence.
//
// Settings live on the device only. xAI API keys are held by the daemon
// (from the repo-root `.env`), NOT the phone — the browser never sees
// a key. Fields here are strictly UI/voice preferences.

export interface Settings {
  voice: string;
  speed: number;
  format: 'md' | 'txt' | 'json';
  timestamps: boolean;
}

const KEY = 'clawkie.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  voice: 'Samantha (en-US)',
  speed: 1.05,
  format: 'md',
  timestamps: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // storage full or disabled — settings won't persist, but the app still works.
  }
}
