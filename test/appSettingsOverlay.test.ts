// @vitest-environment jsdom

import { act, createElement, Fragment, useEffect, useState, type ReactNode } from 'react';
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
  DrivingScreen: ({ onSettings, onSessions }: { onSettings?: () => void; onSessions?: () => void }) => {
    const [phase, setPhase] = useState('READY');
    useEffect(() => {
      drivingProbe.mounts += 1;
      return () => {
        drivingProbe.unmounts += 1;
      };
    }, []);

    return createElement(
      'section',
      { 'data-testid': 'driving-screen', 'data-phase': phase },
      createElement('span', { 'data-testid': 'driving-phase' }, phase),
      createElement(
        'button',
        { type: 'button', 'aria-label': 'Settings', onClick: onSettings },
        'Settings',
      ),
      createElement(
        'button',
        { type: 'button', 'aria-label': 'Start thinking', onClick: () => setPhase('THINKING') },
        'Start thinking',
      ),
      createElement(
        'button',
        { type: 'button', 'aria-label': 'Sessions', onClick: onSessions },
        'Sessions',
      ),
    );
  },
}));

type MockRecentSession = {
  sessionId: string;
  sessionKey: string;
  agent: string;
  displayLabel: string;
};

vi.mock('../client/src/screens/Dashboard', () => ({
  DashboardScreen: ({ onSelectSession }: { onSelectSession?: (session: MockRecentSession) => void }) => createElement(
    'section',
    { 'data-testid': 'dashboard-screen' },
    createElement(
      'button',
      {
        type: 'button',
        'aria-label': 'Return to current session',
        onClick: () => onSelectSession?.({
          sessionId: 'session-1',
          sessionKey: 'agent:main',
          agent: 'main',
          displayLabel: 'Main',
        }),
      },
      'Return to current session',
    ),
    createElement(
      'button',
      {
        type: 'button',
        'aria-label': 'Open different session',
        onClick: () => onSelectSession?.({
          sessionId: 'session-2',
          sessionKey: 'agent:main',
          agent: 'main',
          displayLabel: 'Other',
        }),
      },
      'Open different session',
    ),
  ),
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

  it('keeps the same Driving screen mounted during a same-session dashboard roundtrip', async () => {
    const view = await renderApp();
    expect(view.querySelector('[data-testid="driving-screen"]')).not.toBeNull();
    expect(drivingProbe.mounts).toBe(1);

    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Start thinking"]')?.click();
    });
    expect(view.querySelector('[data-testid="driving-phase"]')?.textContent).toBe('THINKING');

    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Sessions"]')?.click();
    });

    expect(view.querySelector('[data-testid="dashboard-screen"]')).not.toBeNull();
    expect(view.querySelector('[data-testid="driving-screen"]')).not.toBeNull();
    expect(view.querySelector('[data-testid="driving-phase"]')?.textContent).toBe('THINKING');
    expect(drivingProbe.mounts).toBe(1);
    expect(drivingProbe.unmounts).toBe(0);

    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Return to current session"]')?.click();
    });

    expect(view.querySelector('[data-testid="dashboard-screen"]')).toBeNull();
    expect(view.querySelector('[data-testid="driving-phase"]')?.textContent).toBe('THINKING');
    expect(drivingProbe.mounts).toBe(1);
    expect(drivingProbe.unmounts).toBe(0);
  });

  it('resets Driving screen state when selecting a different session from the dashboard', async () => {
    const view = await renderApp();

    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Start thinking"]')?.click();
    });
    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Sessions"]')?.click();
    });
    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Open different session"]')?.click();
    });

    expect(view.querySelector('[data-testid="dashboard-screen"]')).toBeNull();
    expect(view.querySelector('[data-testid="driving-phase"]')?.textContent).toBe('READY');
    expect(drivingProbe.mounts).toBe(2);
    expect(drivingProbe.unmounts).toBe(1);
  });

  it('hides the preserved Driving screen from layout and assistive tech while dashboard is visible', async () => {
    const view = await renderApp();

    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Sessions"]')?.click();
    });

    const driving = view.querySelector<HTMLElement>('[data-testid="driving-screen"]');
    const preservedWrapper = driving?.parentElement;
    expect(view.querySelector('[data-testid="dashboard-screen"]')).not.toBeNull();
    expect(preservedWrapper?.style.display).toBe('none');
    expect(preservedWrapper?.getAttribute('aria-hidden')).toBe('true');
    expect(drivingProbe.mounts).toBe(1);
    expect(drivingProbe.unmounts).toBe(0);
  });

  it('isolates the base content from assistive tech and focus while Settings is open', async () => {
    const view = await renderApp();

    await act(async () => {
      view.querySelector<HTMLButtonElement>('[aria-label="Settings"]')?.click();
    });

    const driving = view.querySelector('[data-testid="driving-screen"]');
    const baseContent = driving?.closest('[aria-hidden="true"][inert]');
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
