// Pins the settings-storage boundary in `client/src/storage.ts`.
// Export prefs remain global for history/export consumers, while
// voice/provider settings are scoped by host peer id under `hosts`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

describe('dashboard host recovery storage', () => {
  it('remembers the last dashboard host for PWA launches', async () => {
    const { loadLastDashboardHostPeerId, saveLastDashboardHostPeerId } = await import('../client/src/storage');

    expect(loadLastDashboardHostPeerId()).toBeNull();
    saveLastDashboardHostPeerId(' host-1 ');

    expect(loadLastDashboardHostPeerId()).toBe('host-1');
  });
});

describe('settings storage', () => {
  it('returns defaults with no selected TTS provider, model, or voice when nothing is stored', async () => {
    const { loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    const settings = loadSettings('host-1');
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.tts.providerId).toBeUndefined();
    expect(settings.tts.model).toBeUndefined();
    expect(settings.tts.voice).toBeUndefined();
    expect(settings.stt).toEqual({});
    expect(settings.music).toEqual({ muted: false, effects: true, disabledTracks: [] });
  });

  it('ignores legacy global TTS, STT, and voice settings for a host-scoped load', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        voice: 'rex',
        tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
        stt: { providerId: 'xai', model: 'grok-stt' },
        format: 'txt',
        timestamps: true,
      }),
    );

    const { loadSettings } = await import('../client/src/storage');
    expect(loadSettings('host-1')).toEqual({
      voice: '',
      tts: {},
      stt: {},
      music: { muted: false, effects: true, disabledTracks: [] },
      format: 'txt',
      timestamps: true,
    });
  });

  it('also ignores legacy global voice/provider settings when no host id is provided', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        voice: 'rex',
        tts: { providerId: 'openai', voice: 'nova' },
        stt: { providerId: 'xai' },
        format: 'json',
      }),
    );

    const { loadSettings } = await import('../client/src/storage');
    expect(loadSettings()).toEqual({
      voice: '',
      tts: {},
      stt: {},
      music: { muted: false, effects: true, disabledTracks: [] },
      format: 'json',
      timestamps: false,
    });
  });

  it('loads TTS and STT selections from the matching host only', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        format: 'txt',
        timestamps: true,
        hosts: {
          'host-1': {
            tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
            stt: { providerId: 'xai', model: 'grok-stt' },
            voice: 'nova',
          },
          'host-2': {
            tts: { providerId: 'other', voice: 'other-voice' },
            stt: { providerId: 'other-stt' },
            voice: 'other-voice',
          },
        },
      }),
    );

    const { loadSettings } = await import('../client/src/storage');
    expect(loadSettings('host-1')).toEqual({
      voice: 'nova',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
      stt: { providerId: 'xai', model: 'grok-stt' },
      music: { muted: false, effects: true, disabledTracks: [] },
      format: 'txt',
      timestamps: true,
    });
    expect(loadSettings('missing-host')).toEqual({
      voice: '',
      tts: {},
      stt: {},
      music: { muted: false, effects: true, disabledTracks: [] },
      format: 'txt',
      timestamps: true,
    });
  });

  it('trims host-scoped STT string fields and drops empty or non-string values', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        hosts: {
          'host-1': { stt: { providerId: ' xai ', model: '   ', extra: 42 } },
        },
      }),
    );
    const { loadSettings } = await import('../client/src/storage');
    expect(loadSettings('host-1').stt).toEqual({ providerId: 'xai' });
  });

  it('drops non-string host-scoped STT fields entirely', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        hosts: {
          'host-1': { stt: { providerId: 42, model: ['nope'] } },
        },
      }),
    );
    const { loadSettings } = await import('../client/src/storage');
    expect(loadSettings('host-1').stt).toEqual({});
  });

  it('trims host-scoped TTS fields and can use the host voice mirror', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        hosts: {
          'host-1': {
            tts: { providerId: ' openai ', model: '   ', voice: 123 },
            voice: ' rex ',
          },
        },
      }),
    );
    const { loadSettings } = await import('../client/src/storage');
    const settings = loadSettings('host-1');
    expect(settings.tts).toEqual({ providerId: 'openai', voice: 'rex' });
    expect(settings.voice).toBe('rex');
  });

  it('saveSettings writes voice/provider settings only under the active host', async () => {
    const { saveSettings, loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    saveSettings({
      ...DEFAULT_SETTINGS,
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
      voice: 'nova',
      stt: { providerId: 'xai', model: 'grok-stt' },
      format: 'json',
      timestamps: true,
    }, 'host-1');

    const raw = localStorage.getItem('clawkie.settings.v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed).toEqual({
      format: 'json',
      timestamps: true,
      hosts: {
        'host-1': {
          voice: 'nova',
          tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
          stt: { providerId: 'xai', model: 'grok-stt' },
        },
      },
    });
    expect(parsed.tts).toBeUndefined();
    expect(parsed.stt).toBeUndefined();
    expect(parsed.voice).toBeUndefined();
    expect(loadSettings('host-1').stt).toEqual({ providerId: 'xai', model: 'grok-stt' });
    expect(loadSettings('host-2').stt).toEqual({});
  });

  it('saveSettings preserves other host records while updating the current host', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        format: 'md',
        timestamps: false,
        hosts: {
          'host-2': { voice: 'ara', tts: { voice: 'ara' }, stt: { providerId: 'other' } },
        },
      }),
    );

    const { saveSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    saveSettings({
      ...DEFAULT_SETTINGS,
      tts: { providerId: 'custom-provider', model: 'custom-model', voice: 'Samantha (en-US)' },
      voice: 'Samantha (en-US)',
    }, 'host-1');

    const parsed = JSON.parse(localStorage.getItem('clawkie.settings.v1') as string);
    expect(parsed.hosts['host-2']).toEqual({
      voice: 'ara',
      tts: { voice: 'ara' },
      stt: { providerId: 'other' },
    });
    expect(parsed.hosts['host-1']).toEqual({
      voice: 'Samantha (en-US)',
      tts: { providerId: 'custom-provider', model: 'custom-model', voice: 'Samantha (en-US)' },
      stt: {},
    });
  });

  it('saveSettings with no host only writes global export prefs and preserves existing hosts', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({
        hosts: {
          'host-1': { voice: 'nova', tts: { voice: 'nova' }, stt: {} },
        },
      }),
    );
    const { saveSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    saveSettings({
      ...DEFAULT_SETTINGS,
      tts: { providerId: 'openai', voice: 'rex' },
      voice: 'rex',
      stt: { providerId: 'xai' },
      format: 'txt',
      timestamps: true,
    });

    const parsed = JSON.parse(localStorage.getItem('clawkie.settings.v1') as string);
    expect(parsed).toEqual({
      format: 'txt',
      timestamps: true,
      hosts: {
        'host-1': { voice: 'nova', tts: { voice: 'nova' }, stt: {} },
      },
    });
  });

  it('saveSettings preserves an updated host voice mirror over a stale TTS voice', async () => {
    const { saveSettings, loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    saveSettings({
      ...DEFAULT_SETTINGS,
      tts: { voice: 'rex' },
      voice: 'leo',
    }, 'host-1');

    const parsed = JSON.parse(localStorage.getItem('clawkie.settings.v1') as string);
    expect(parsed.hosts['host-1'].tts.voice).toBe('leo');
    expect(parsed.hosts['host-1'].voice).toBe('leo');
    expect(loadSettings('host-1').tts.voice).toBe('leo');
  });

  it('saveSettings preserves Default TTS as empty host-scoped TTS and blank voice', async () => {
    const { saveSettings, loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    saveSettings({
      ...DEFAULT_SETTINGS,
      tts: {},
      voice: '',
    }, 'host-1');

    const parsed = JSON.parse(localStorage.getItem('clawkie.settings.v1') as string);
    expect(parsed.hosts['host-1'].tts).toEqual({});
    expect(parsed.hosts['host-1'].voice).toBe('');
    expect(loadSettings('host-1').tts).toEqual({});
    expect(loadSettings('host-1').voice).toBe('');
  });

  it('exposes global export settings without applying legacy voice/provider settings', async () => {
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({ voice: 'leo', tts: { voice: 'leo' }, format: 'json', timestamps: true }),
    );
    const { loadExportSettings, loadSettings, DEFAULT_EXPORT_SETTINGS } = await import('../client/src/storage');
    expect(loadExportSettings()).toEqual({ format: 'json', timestamps: true });
    expect(loadSettings('host-1').voice).toBe('');
    expect(DEFAULT_EXPORT_SETTINGS).toEqual({ format: 'md', timestamps: false });
  });


  it('loads music settings globally while preserving the legacy hold-music mute key', async () => {
    localStorage.setItem('clawkie.holdMusic.muted.v1', '1');
    const { loadSettings, loadMusicSettings } = await import('../client/src/storage');

    expect(loadMusicSettings()).toEqual({ muted: true, effects: true, disabledTracks: [] });
    expect(loadSettings('host-1').music).toEqual({ muted: true, effects: true, disabledTracks: [] });
  });

  it('saves normalized music settings globally and mirrors mute to the legacy key', async () => {
    const { saveSettings, loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');

    saveSettings({
      ...DEFAULT_SETTINGS,
      music: {
        muted: true,
        effects: false,
        disabledTracks: [' Soft Hold Tone.mp3 ', '', 'Soft Hold Tone.mp3', 'Dockside Hold.mp3'],
      },
    }, 'host-1');

    const parsed = JSON.parse(localStorage.getItem('clawkie.settings.v1') as string);
    expect(parsed.music).toEqual({
      muted: true,
      effects: false,
      disabledTracks: ['Soft Hold Tone.mp3', 'Dockside Hold.mp3'],
    });
    expect(localStorage.getItem('clawkie.holdMusic.muted.v1')).toBe('1');
    expect(loadSettings('host-2').music).toEqual({
      muted: true,
      effects: false,
      disabledTracks: ['Soft Hold Tone.mp3', 'Dockside Hold.mp3'],
    });
  });

  it('removes persisted default music settings and clears the legacy mute key', async () => {
    localStorage.setItem('clawkie.holdMusic.muted.v1', '1');
    localStorage.setItem(
      'clawkie.settings.v1',
      JSON.stringify({ music: { muted: true, effects: false, disabledTracks: ['Soft Hold Tone.mp3'] } }),
    );
    const { saveMusicSettings, loadMusicSettings } = await import('../client/src/storage');

    saveMusicSettings({ muted: false, effects: true, disabledTracks: [] });

    expect(loadMusicSettings()).toEqual({ muted: false, effects: true, disabledTracks: [] });
    expect(localStorage.getItem('clawkie.holdMusic.muted.v1')).toBeNull();
    expect(JSON.parse(localStorage.getItem('clawkie.settings.v1') as string).music).toBeUndefined();
  });

  it('falls back to defaults when persisted record is corrupt', async () => {
    localStorage.setItem('clawkie.settings.v1', 'not-json');
    const { loadSettings, DEFAULT_SETTINGS } = await import('../client/src/storage');
    expect(loadSettings('host-1')).toEqual(DEFAULT_SETTINGS);
  });
});

describe('favorite recent session storage', () => {
  const daemonSession = {
    sessionId: ' session-1 ',
    sessionKey: ' agent:kamaji:discord:channel:t1 ',
    agent: ' kamaji ',
    channel: ' discord ',
    target: ' channel:t1 ',
    accountId: ' acct-1 ',
    lastActivity: ' 2026-05-07T18:30:00.000Z ',
    displayLabel: ' Kamaji thread ',
    extra: 'drop me',
  } as never;

  it('persists normalized favorite sessions under the active host only', async () => {
    const { loadFavoriteRecentSessions, saveFavoriteRecentSession } = await import('../client/src/storage');

    expect(saveFavoriteRecentSession(' host-1 ', daemonSession)).toEqual({
      sessionId: 'session-1',
      sessionKey: 'agent:kamaji:discord:channel:t1',
      agent: 'kamaji',
      channel: 'discord',
      target: 'channel:t1',
      accountId: 'acct-1',
      lastActivity: '2026-05-07T18:30:00.000Z',
      displayLabel: 'Kamaji thread',
    });

    expect(loadFavoriteRecentSessions('host-1')).toHaveLength(1);
    expect(loadFavoriteRecentSessions('host-2')).toEqual([]);
    expect(JSON.parse(localStorage.getItem('clawkie.favoriteSessions.v1') as string)).toEqual({
      hosts: {
        'host-1': {
          sessions: [
            {
              sessionId: 'session-1',
              sessionKey: 'agent:kamaji:discord:channel:t1',
              agent: 'kamaji',
              channel: 'discord',
              target: 'channel:t1',
              accountId: 'acct-1',
              lastActivity: '2026-05-07T18:30:00.000Z',
              displayLabel: 'Kamaji thread',
            },
          ],
        },
      },
    });
  });

  it('merges favorites before non-favorites while letting daemon metadata win', async () => {
    const { mergeRecentSessionsWithFavorites } = await import('../client/src/storage');

    expect(
      mergeRecentSessionsWithFavorites(
        [
          {
            sessionId: 'session-2',
            sessionKey: 'daemon-only',
            agent: 'ryu',
            displayLabel: 'Daemon only',
          },
          {
            sessionId: 'session-1',
            sessionKey: 'stable-key',
            agent: 'kamaji',
            channel: 'discord',
            target: 'channel:fresh',
            displayLabel: 'Fresh daemon label',
          },
        ],
        [
          {
            sessionId: 'stale-session-id',
            sessionKey: 'stable-key',
            agent: 'old',
            displayLabel: 'Stale stored label',
          },
          {
            sessionId: 'session-3',
            sessionKey: 'stored-key',
            agent: 'kamaji',
            channel: 'discord',
            target: 'channel:stored',
            accountId: 'acct-1',
            displayLabel: 'Stored favorite',
          },
        ],
      ),
    ).toEqual([
      {
        sessionId: 'session-1',
        sessionKey: 'stable-key',
        agent: 'kamaji',
        channel: 'discord',
        target: 'channel:fresh',
        displayLabel: 'Fresh daemon label',
        favorite: true,
      },
      {
        sessionId: 'session-3',
        sessionKey: 'stored-key',
        agent: 'kamaji',
        channel: 'discord',
        target: 'channel:stored',
        accountId: 'acct-1',
        displayLabel: 'Stored favorite',
        favorite: true,
        persistedFavorite: true,
      },
      {
        sessionId: 'session-2',
        sessionKey: 'daemon-only',
        agent: 'ryu',
        displayLabel: 'Daemon only',
      },
    ]);
  });

  it('removes favorites and refreshes stored metadata from later daemon rows', async () => {
    const {
      loadFavoriteRecentSessions,
      reconcileFavoriteRecentSessions,
      removeFavoriteRecentSession,
      saveFavoriteRecentSession,
    } = await import('../client/src/storage');

    saveFavoriteRecentSession('host-1', {
      sessionId: 'session-1',
      sessionKey: 'stable-key',
      agent: 'old',
      displayLabel: 'Stale',
    });
    reconcileFavoriteRecentSessions('host-1', [
      {
        sessionId: 'session-2',
        sessionKey: 'stable-key',
        agent: 'kamaji',
        channel: 'discord',
        target: 'channel:fresh',
        displayLabel: 'Fresh',
      },
    ]);
    expect(loadFavoriteRecentSessions('host-1')[0]).toMatchObject({
      sessionId: 'session-2',
      sessionKey: 'stable-key',
      target: 'channel:fresh',
      displayLabel: 'Fresh',
    });

    removeFavoriteRecentSession('host-1', { sessionId: ' session-9 ', sessionKey: ' stable-key ' });
    expect(loadFavoriteRecentSessions('host-1')).toEqual([]);
  });

  it('can remove a stored favorite from a legacy session-id-only reference', async () => {
    const {
      loadFavoriteRecentSessions,
      removeFavoriteRecentSession,
      saveFavoriteRecentSession,
    } = await import('../client/src/storage');

    saveFavoriteRecentSession('host-1', {
      sessionId: 'legacy-session-id',
      sessionKey: 'stable-key',
      agent: 'kamaji',
      displayLabel: 'Stored',
    });

    removeFavoriteRecentSession('host-1', { sessionId: ' legacy-session-id ' });
    expect(loadFavoriteRecentSessions('host-1')).toEqual([]);
  });

  it('rekeys favorites by stable session key when OpenClaw changes the session id', async () => {
    const {
      loadFavoriteRecentSessions,
      mergeRecentSessionsWithFavorites,
      reconcileFavoriteRecentSessions,
      saveFavoriteRecentSession,
    } = await import('../client/src/storage');

    saveFavoriteRecentSession('host-1', {
      sessionId: 'old-session-uuid',
      sessionKey: 'agent:kamaji:discord:channel:thread-1',
      agent: 'kamaji',
      channel: 'discord',
      target: 'channel:thread-1',
      accountId: 'acct-1',
      lastActivity: '2026-05-07T18:30:00.000Z',
      displayLabel: 'Old daemon label',
    });

    const daemonSessions = [
      {
        sessionId: 'new-session-uuid',
        sessionKey: 'agent:kamaji:discord:channel:thread-1',
        agent: 'kamaji',
        channel: 'discord',
        target: 'channel:thread-1',
        accountId: 'acct-2',
        lastActivity: '2026-05-08T17:30:00.000Z',
        displayLabel: 'Fresh daemon label',
      },
    ];

    expect(reconcileFavoriteRecentSessions('host-1', daemonSessions)).toEqual([
      {
        sessionId: 'new-session-uuid',
        sessionKey: 'agent:kamaji:discord:channel:thread-1',
        agent: 'kamaji',
        channel: 'discord',
        target: 'channel:thread-1',
        accountId: 'acct-2',
        lastActivity: '2026-05-08T17:30:00.000Z',
        displayLabel: 'Fresh daemon label',
      },
    ]);
    expect(loadFavoriteRecentSessions('host-1')).toHaveLength(1);
    expect(mergeRecentSessionsWithFavorites(daemonSessions, loadFavoriteRecentSessions('host-1'))).toEqual([
      {
        sessionId: 'new-session-uuid',
        sessionKey: 'agent:kamaji:discord:channel:thread-1',
        agent: 'kamaji',
        channel: 'discord',
        target: 'channel:thread-1',
        accountId: 'acct-2',
        lastActivity: '2026-05-08T17:30:00.000Z',
        displayLabel: 'Fresh daemon label',
        favorite: true,
      },
    ]);
  });
});
