// @vitest-environment jsdom

import { act, createElement, Fragment, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const drivingProbe = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
}));

const rtcProbe = vi.hoisted(() => ({
  voiceSettings: [] as unknown[],
}));

vi.mock('../client/src/rtc/RtcContext', async () => {
  const actual = await vi.importActual<typeof import('../client/src/rtc/RtcContext')>(
    '../client/src/rtc/RtcContext',
  );
  return {
    ...actual,
    RtcProvider: ({
      children,
      voiceSettings,
    }: {
      children: ReactNode;
      voiceSettings?: unknown;
    }) => {
      rtcProbe.voiceSettings.push(voiceSettings);
      return createElement(Fragment, null, children);
    },
    useRtc: () => ({
      status: 'open',
      detail: undefined,
      sendControl: () => undefined,
      sendBinary: () => undefined,
      addControlListener: () => () => undefined,
      addBinaryListener: () => () => undefined,
      addRemoteStreamListener: () => () => undefined,
      ttsCatalog: null,
      requestTtsCatalog: () => undefined,
      sttCatalog: null,
      requestSttCatalog: () => undefined,
      hasClient: true,
    }),
  };
});

vi.mock('../client/src/screens/Driving', () => ({
  DrivingScreen: ({ onSettings }: { onSettings?: () => void }) => {
    useEffect(() => {
      drivingProbe.mounts += 1;
      return () => {
        drivingProbe.unmounts += 1;
      };
    }, []);

    return createElement(
      'section',
      { 'data-testid': 'driving-screen' },
      createElement(
        'button',
        { type: 'button', 'aria-label': 'Settings', onClick: onSettings },
        'Settings',
      ),
    );
  },
}));

vi.mock('../client/src/screens/Settings', () => ({
  SettingsScreen: ({ onBack }: { onBack: () => void }) => createElement(
    'section',
    { 'data-testid': 'settings-screen' },
    createElement('button', { type: 'button', onClick: onBack }, 'Back'),
  ),
}));

vi.mock('../client/src/screens/History', () => ({
  HistoryScreen: () => createElement('section', { 'data-testid': 'history-screen' }),
}));

vi.mock('../client/src/screens/Transcript', () => ({
  TranscriptScreen: () => createElement('section', { 'data-testid': 'transcript-screen' }),
}));

vi.mock('../client/src/screens/ErrorScreen', () => ({
  ErrorScreen: () => createElement('section', { 'data-testid': 'error-screen' }),
}));

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  clear(): void {
    this.data.clear();
  }
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderApp(hash = '#host=host-1&session=session-1'): Promise<HTMLDivElement> {
  window.history.replaceState(null, '', `/voice${hash}`);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const { App } = await import('../client/src/app');
  await act(async () => {
    root?.render(createElement(App));
  });
  return container;
}

function getDialog(): HTMLElement {
  const dialog = container?.querySelector<HTMLElement>('[role="dialog"][aria-label="Settings"]');
  if (!dialog) throw new Error('missing Settings dialog');
  return dialog;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  drivingProbe.mounts = 0;
  drivingProbe.unmounts = 0;
  rtcProbe.voiceSettings = [];
  container = null;
  root = null;
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe('App Settings overlay behavior', () => {
  it('seeds RTC voice settings from the current host record and ignores legacy global voice/provider settings', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        voice: 'global-rex',
        tts: { providerId: 'global-provider', voice: 'global-rex' },
        stt: { providerId: 'global-stt' },
        hosts: {
          'host-1': {
            voice: 'nova',
            tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
            stt: { providerId: 'xai', model: 'grok-stt' },
          },
        },
      }),
    );

    await renderApp();

    expect(rtcProbe.voiceSettings.at(-1)).toEqual({
      voice: 'nova',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
      stt: { providerId: 'xai', model: 'grok-stt' },
    });
  });

  it('opens Settings as a dialog overlay while keeping the Driving screen mounted behind it', async () => {
    const view = await renderApp();
    expect(view.querySelector('[data-testid="driving-screen"]')).not.toBeNull();
    expect(drivingProbe.mounts).toBe(1);

    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Settings"]')?.click();
    });

    const dialog = getDialog();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(dialog);
    expect(view.querySelector('[data-testid="settings-screen"]')).not.toBeNull();
    expect(view.querySelector('[data-testid="driving-screen"]')).not.toBeNull();
    expect(drivingProbe.mounts).toBe(1);
    expect(drivingProbe.unmounts).toBe(0);
  });

  it('isolates the base content from assistive tech and focus while Settings is open', async () => {
    const view = await renderApp();

    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Settings"]')?.click();
    });

    const driving = view.querySelector('[data-testid="driving-screen"]');
    const baseContent = driving?.parentElement;
    expect(baseContent?.getAttribute('aria-hidden')).toBe('true');
    expect(baseContent?.getAttribute('inert')).toBe('');
  });

  it('does not close Settings when the scrim is clicked', async () => {
    const view = await renderApp();
    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Settings"]')?.click();
    });

    const scrim = getDialog().parentElement?.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(scrim).not.toBeNull();

    await act(async () => {
      scrim?.click();
    });

    expect(getDialog()).not.toBeNull();
    expect(view.querySelector('[data-testid="driving-screen"]')).not.toBeNull();
    expect(drivingProbe.unmounts).toBe(0);
  });

  it('closes Settings locally from Escape or the Settings back action without routing away', async () => {
    const view = await renderApp();
    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Settings"]')?.click();
    });

    await act(async () => {
      getDialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(view.querySelector('[role="dialog"][aria-label="Settings"]')).toBeNull();
    expect(view.querySelector('[data-testid="driving-screen"]')).not.toBeNull();
    expect(drivingProbe.mounts).toBe(1);
    expect(drivingProbe.unmounts).toBe(0);

    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Settings"]')?.click();
    });
    await act(async () => {
      view.querySelector<HTMLButtonElement>('[data-testid="settings-screen"] button')?.click();
    });

    expect(view.querySelector('[role="dialog"][aria-label="Settings"]')).toBeNull();
    expect(view.querySelector('[data-testid="driving-screen"]')).not.toBeNull();
    expect(drivingProbe.mounts).toBe(1);
    expect(drivingProbe.unmounts).toBe(0);
  });
});
