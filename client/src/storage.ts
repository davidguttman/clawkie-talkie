// localStorage-backed settings persistence.
//
// Settings live on the device only. The xAI API key is read by the phone
// client at call time for browser-owned STT/TTS; the daemon never sees it.

export type ProviderId = 'xai' | 'openai';
export type ApiKeyStatus = 'unset' | 'checking' | 'ok' | 'invalid';

export interface Settings {
  voice: string;
  speed: number;
  format: 'md' | 'txt' | 'json';
  timestamps: boolean;
  provider: ProviderId;
  apiKeys: Record<ProviderId, string>;
  apiKeyStatuses: Record<ProviderId, ApiKeyStatus>;
}

const KEY = 'clawkie.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  voice: 'Samantha (en-US)',
  speed: 1.05,
  format: 'md',
  timestamps: false,
  provider: 'xai',
  apiKeys: { xai: '', openai: '' },
  apiKeyStatuses: { xai: 'unset', openai: 'unset' },
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      apiKeys: { ...DEFAULT_SETTINGS.apiKeys, ...(parsed.apiKeys || {}) },
      apiKeyStatuses: {
        ...DEFAULT_SETTINGS.apiKeyStatuses,
        ...(parsed.apiKeyStatuses || {}),
      },
    };
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
