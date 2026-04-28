import { useEffect, useRef, useState } from 'react';
import { HIFI, type AccentKey } from '../tokens';
import { ButtonAura, LiveWave } from '../components/Phone';
import { useDrivingLoop, type DrivingState } from '../voice/drivingLoop';
import { getMediaSessionDebugSnapshot, useMediaSessionControls } from '../voice/mediaSession';
import {
  attachMediaSessionKeeperDebugHost,
  getMediaSessionKeeperDebugSnapshot,
  startMediaSessionKeeper,
  stopMediaSessionKeeper,
} from '../voice/mediaSessionKeeper';
import {
  getRemoteTtsAudioDebugSnapshot,
  playPttPressTone,
  unlockDaemonTtsAudio,
} from '../voice/tts';
import { useRtc } from '../rtc/RtcContext';
import { readSttChunkConfigFromLocation } from '../voice/sttDaemon';
import {
  getHoldMusicMuted,
  setHoldMusicMuted,
  subscribeHoldMusicMuted,
} from '../voice/holdMusic';
import type { Settings } from '../storage';

// Runtime driving surface driven by the daemon-owned state machine in
// ../voice/drivingLoop.ts. The phone only captures mic PCM and plays
// daemon-streamed TTS audio; STT, reply generation, and TTS all terminate
// on the daemon side.

export function DrivingScreen({
  accent = 'amber',
  fontMode = 'mono',
  onReplay,
  onHistory,
  onSettings,
  compact = false,
  settings,
  sessionId,
  hostPeerId,
  threadId,
}: {
  accent?: AccentKey;
  fontMode?: 'mono' | 'sans';
  onReplay?: () => string | Promise<string>;
  onHistory?: () => void;
  onSettings?: () => void;
  compact?: boolean;
  settings?: Settings;
  sessionId?: string;
  hostPeerId?: string | null;
  threadId?: string;
}) {
  const accentCfg = HIFI.accents[accent] || HIFI.accents.amber;
  const debugMode = useDebugMode();
  const [replayNotice, setReplayNotice] = useState<string | null>(null);
  const [holdMusicMuted, setHoldMusicMutedState] = useState(() => getHoldMusicMuted());

  const rtc = useRtc();

  const loop = useDrivingLoop({
    ttsRate: settings?.speed ?? 1.05,
    sessionId,
    threadId,
    hostPeerId,
    rtc: {
      status: rtc.status,
      hasClient: rtc.hasClient,
      sendControl: rtc.sendControl,
      sendBinary: rtc.sendBinary,
      addControlListener: rtc.addControlListener,
      addBinaryListener: rtc.addBinaryListener,
    },
  });

  const {
    state,
    liveText,
    isTranscribing,
    lastTurn,
    intensities,
    error,
    daemonConnected,
    tap,
  } = loop;

  // Wire AirPods / lock-screen play-pause buttons to the same tap()
  // entrypoint the on-screen PTT button uses. Feature-detected and a
  // no-op when navigator.mediaSession is unavailable.
  useMediaSessionControls(state, tap);

  useEffect(() => {
    return subscribeHoldMusicMuted(setHoldMusicMutedState);
  }, []);

  // Tear down the silent media-session keeper when the Driving
  // screen unmounts. The keeper itself is started lazily from the
  // PTT gesture (via unlockDaemonTtsAudio); we just own the
  // teardown so it doesn't leak across full-screen navigations.
  useEffect(() => {
    return () => {
      stopMediaSessionKeeper();
    };
  }, []);

  const isRec = state === 'recording';
  const isAI = state === 'ai';
  const isThink = state === 'thinking';

  const stateColor = isRec
    ? accentCfg.rec
    : isAI
      ? HIFI.ai
      : isThink
        ? HIFI.think
        : HIFI.ink3;
  const stateGlow = isRec
    ? accentCfg.recGlow
    : isAI
      ? HIFI.aiGlow
      : isThink
        ? HIFI.thinkGlow
        : 'transparent';

  const baseFont = fontMode === 'sans' ? HIFI.fonts.sans : HIFI.fonts.mono;
  // Compact gutter raised from 2 → 8 so the top-right status pill + gear
  // always sit well inside the viewport on narrow phones, where
  // MobileShell's overflow-x:hidden would otherwise clip them.
  const sidePad = compact ? 8 : 22;

  // Compact uses the shorter "REPLY" label — the full "READING REPLY"
  // wouldn't fit alongside the CLWK label and gear button on narrow phones.
  const statePill = isRec
    ? 'REC'
    : isAI
      ? compact
        ? 'REPLY'
        : 'READING REPLY'
      : isThink
        ? 'THINKING'
        : 'READY';
  const btnLabel = isRec
    ? 'TAP TO STOP'
    : isAI
      ? 'TAP TO SILENCE'
      : isThink
        ? 'THINKING…'
        : 'TAP TO TALK';

  const caption = pickCaption({
    state,
    stateColor,
    liveText,
    isTranscribing,
    lastTurn,
    accentRec: accentCfg.rec,
  });

  const headerLabel = buildHeaderLabel({ sessionId, hostPeerId });
  const rowGap = compact ? 8 : 10;
  const pttButtonSize = compact
    ? 'clamp(164px, min(52vw, 29dvh), 208px)'
    : 'clamp(188px, min(42vw, 30dvh), 208px)';

  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        // Caption (1fr) and the voice-control area (1.2fr) split free
        // space proportionally, so the PTT button gets balanced breathing
        // room above and below regardless of transcript length. Rows are
        // fr-based, not content-based, which is why streaming text in the
        // bounded caption cannot push the button around.
        gridTemplateRows: debugMode
          ? `auto minmax(0, 0.9fr) auto minmax(0, 1fr) auto auto auto`
          : `auto minmax(0, 1fr) auto minmax(0, 1.2fr) auto auto`,
        rowGap,
        padding: compact ? `8px ${sidePad}px 10px` : `12px ${sidePad}px 14px`,
        color: HIFI.ink,
        fontFamily: baseFont,
        minWidth: 0,
        minHeight: 0,
        width: '100%',
        boxSizing: 'border-box',
        maxWidth: '100%',
        overflow: 'hidden',
      }}
    >
      {/* header — full hi-fi layout in both compact and desktop. Status
          pill is always visible so the user can read state at a glance. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: compact ? 8 : 10,
          minWidth: 0,
          width: '100%',
          minHeight: 0,
        }}
      >
        <div
          style={{
            fontFamily: HIFI.fonts.mono,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: 1.2,
            color: HIFI.ink2,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {headerLabel}
        </div>
        <div
          style={{
            display: 'inline-flex',
            gap: 5,
            alignItems: 'center',
            padding: '3px 9px',
            borderRadius: 20,
            border: `1px solid ${stateColor}55`,
            background: `${stateColor}11`,
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1.2,
            color: stateColor,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: stateColor,
              boxShadow: `0 0 8px ${stateColor}`,
              animation:
                isRec || isAI || isThink ? 'pulseDot 1.2s ease-in-out infinite' : 'none',
            }}
          />
          {statePill}
        </div>
        {onSettings && (
          <button
            onClick={onSettings}
            style={{
              width: 30,
              height: 30,
              borderRadius: 10,
              background: 'transparent',
              border: `1px solid ${HIFI.stroke}`,
              color: HIFI.ink2,
              cursor: 'pointer',
              fontFamily: HIFI.fonts.mono,
              fontSize: 15,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              boxSizing: 'border-box',
              appearance: 'none',
              WebkitAppearance: 'none',
              padding: 0,
            }}
            aria-label="Settings"
          >
            ⚙
          </button>
        )}
      </div>

      {/* caption — bounded so live text scrolls instead of moving controls.
          Bottom border frames the transcript and visually separates it
          from the voice-control area (waveform + PTT button) below. */}
      <div
        style={{
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
          paddingBottom: compact ? 8 : 10,
          borderBottom: `1px solid ${HIFI.stroke}`,
        }}
      >
        <Caption
          caption={caption}
          baseFont={baseFont}
          error={error}
          daemonConnected={daemonConnected}
          hasRtcClient={rtc.hasClient}
          rtcStatus={rtc.status}
          compact={compact}
        />
      </div>
      {/* waveform sits at its natural height directly above the PTT
          button so the two read as one voice-control unit. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        <LiveWave
          intensities={intensities}
          color={stateColor}
          width="100%"
          height={compact ? 30 : 34}
        />
      </div>

      {/* BIG BUTTON — centered inside a flexible row so the breathing
          room above (between waveform and button) and below (between
          button and footer) is balanced by the grid, not hard-coded. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          minHeight: 0,
          overflow: 'visible',
        }}
      >
        <PTTButton
          onTap={tap}
          onToggleHoldMusicMuted={() => setHoldMusicMuted(!getHoldMusicMuted())}
          holdMusicMuted={holdMusicMuted}
          state={state}
          stateColor={stateColor}
          stateGlow={stateGlow}
          label={btnLabel}
          accentRec={accentCfg.rec}
          size={pttButtonSize}
        />
      </div>

      {debugMode && (
        <MediaSessionDebugPanel
          baseFont={baseFont}
          compact={compact}
          state={state}
          rtcStatus={rtc.status}
        />
      )}

      {/* footer — REPLAY and HISTORY side-by-side. Settings lives in the
          header gear button (visible in both compact and desktop). */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
          minWidth: 0,
        }}
      >
        <FooterButton
          icon="↺"
          label="REPLAY"
          onClick={
            onReplay
              ? async () => {
                  const message = await onReplay();
                  setReplayNotice(message);
                }
              : undefined
          }
          compact={compact}
        />
        <FooterButton icon="≡" label="HISTORY" onClick={onHistory} compact={compact} />
      </div>
      {replayNotice && <ReplayNotice message={replayNotice} compact={compact} />}
    </div>
  );
}

function ReplayNotice({ message, compact }: { message: string; compact: boolean }) {
  return (
    <div
      role="status"
      style={{
        marginTop: compact ? -2 : 0,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontFamily: HIFI.fonts.mono,
        fontSize: 10,
        letterSpacing: 1,
        color: HIFI.ink3,
        textAlign: 'center',
      }}
    >
      {message.toUpperCase()}
    </div>
  );
}

function useDebugMode(): boolean {
  const [enabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('debug') === 'true';
  });
  return enabled;
}

interface DebugSnapshot {
  mediaSession: ReturnType<typeof getMediaSessionDebugSnapshot>;
  keeper: ReturnType<typeof getMediaSessionKeeperDebugSnapshot>;
  remoteTts: ReturnType<typeof getRemoteTtsAudioDebugSnapshot>;
}

function readDebugSnapshot(): DebugSnapshot {
  return {
    mediaSession: getMediaSessionDebugSnapshot(),
    keeper: getMediaSessionKeeperDebugSnapshot(),
    remoteTts: getRemoteTtsAudioDebugSnapshot(),
  };
}

function MediaSessionDebugPanel({
  baseFont,
  compact,
  state,
  rtcStatus,
}: {
  baseFont: string;
  compact: boolean;
  state: DrivingState;
  rtcStatus: string;
}) {
  const audioHostRef = useRef<HTMLDivElement | null>(null);
  const [snapshot, setSnapshot] = useState<DebugSnapshot>(() => readDebugSnapshot());

  useEffect(() => {
    startMediaSessionKeeper();

    let detachKeeperControls: (() => void) | null = null;
    const sync = () => {
      const host = audioHostRef.current;
      if (host && !host.querySelector('audio') && getMediaSessionKeeperDebugSnapshot().present) {
        detachKeeperControls?.();
        detachKeeperControls = attachMediaSessionKeeperDebugHost(host);
      }
      setSnapshot(readDebugSnapshot());
    };

    sync();
    const timer = window.setInterval(sync, 500);
    return () => {
      window.clearInterval(timer);
      detachKeeperControls?.();
    };
  }, []);

  const mediaSessionRows = [
    ['mediaSession', snapshot.mediaSession.available ? 'available' : 'missing'],
    ['playbackState', snapshot.mediaSession.playbackState],
    ['handlers', formatActionHandlers(snapshot.mediaSession.actionHandlers)],
    ['micControl', formatMicrophoneDebug(snapshot.mediaSession.microphone)],
    ['actions', `${snapshot.mediaSession.actions.count}`],
    ['lastAction', formatLastMediaAction(snapshot.mediaSession.actions.last)],
    ['metadata', snapshot.mediaSession.metadataInstalled ? 'installed' : 'not installed'],
    ['drivingState', state],
    ['rtc', rtcStatus],
    ['sttChunking', formatSttChunking()],
  ];
  const keeperRows = [
    ['present', boolLabel(snapshot.keeper.present)],
    ['paused', nullableBoolLabel(snapshot.keeper.paused)],
    ['currentTime', formatNumber(snapshot.keeper.currentTime)],
    ['readyState', formatNullable(snapshot.keeper.readyState)],
    ['events', `play=${snapshot.keeper.events.playCount} pause=${snapshot.keeper.events.pauseCount}`],
    ['lastEvent', formatLastKeeperEvent(snapshot.keeper.events.last)],
    ['src', formatSrc(snapshot.keeper.src)],
  ];
  const remoteRows = [
    ['present', boolLabel(snapshot.remoteTts.present)],
    ['paused', nullableBoolLabel(snapshot.remoteTts.paused)],
    ['currentTime', formatNumber(snapshot.remoteTts.currentTime)],
    ['readyState', formatNullable(snapshot.remoteTts.readyState)],
    ['srcObject', formatRemoteSrcObject(snapshot.remoteTts.srcObject)],
    ['src', formatSrc(snapshot.remoteTts.src)],
  ];
  const conclusion = buildDebugConclusion(snapshot, state);

  return (
    <section
      style={{
        minWidth: 0,
        maxWidth: '100%',
        borderTop: `1px solid ${HIFI.stroke}`,
        paddingTop: compact ? 7 : 9,
        overflow: 'hidden',
        color: HIFI.ink2,
      }}
      aria-label="Media session debug"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 6,
          fontFamily: HIFI.fonts.mono,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 1.2,
          color: HIFI.ink,
        }}
      >
        <span>MEDIA DEBUG</span>
        <span style={{ color: snapshot.keeper.present ? HIFI.ai : '#ef6155' }}>
          KEEPER {snapshot.keeper.present ? 'READY' : 'MISSING'}
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr' : '1fr 1fr',
          gap: 5,
          marginBottom: 6,
          fontFamily: HIFI.fonts.mono,
          fontSize: 10,
          lineHeight: 1.35,
          color: HIFI.ink2,
        }}
      >
        <div
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={conclusion.hardwareLine}
        >
          {conclusion.hardwareLine}
        </div>
        <div
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={conclusion.keeperLine}
        >
          {conclusion.keeperLine}
        </div>
      </div>

      <div
        ref={audioHostRef}
        style={{
          minHeight: 36,
          display: 'flex',
          alignItems: 'center',
          marginBottom: 7,
          borderRadius: 8,
          border: `1px solid ${HIFI.stroke}`,
          background: 'rgba(255,255,255,0.04)',
          padding: 4,
        }}
      >
        {!snapshot.keeper.present && (
          <div
            style={{
              width: '100%',
              fontFamily: HIFI.fonts.mono,
              fontSize: 10,
              color: HIFI.ink3,
              textAlign: 'center',
            }}
          >
            keeper audio element not created
          </div>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr' : '1fr 1fr 1fr',
          gap: compact ? 5 : 8,
          maxHeight: compact ? 118 : 132,
          overflowY: 'auto',
          paddingRight: 4,
          fontFamily: baseFont,
        }}
      >
        <DebugGroup title="mediaSession" rows={mediaSessionRows} />
        <DebugGroup title="keeperAudio" rows={keeperRows} />
        <DebugGroup title="remoteTtsAudio" rows={remoteRows} />
      </div>
    </section>
  );
}

function buildDebugConclusion(snapshot: DebugSnapshot, state: DrivingState): {
  hardwareLine: string;
  keeperLine: string;
} {
  const hardwareEvent = snapshot.mediaSession.actions.count > 0 ? 'yes' : 'no';
  return {
    hardwareLine: `hardwareEvent=${hardwareEvent} probableLayer=${probableLayerFor(snapshot, state)}`,
    keeperLine: `keeperEvents play=${snapshot.keeper.events.playCount} pause=${
      snapshot.keeper.events.pauseCount
    } last=${formatLastKeeperEvent(snapshot.keeper.events.last)}`,
  };
}

function probableLayerFor(snapshot: DebugSnapshot, state: DrivingState): string {
  if (snapshot.mediaSession.actions.count > 0) return 'js_media_session';
  if (snapshot.keeper.events.pauseCount > 0) return 'keeper_audio_element';
  if (state === 'recording' && snapshot.mediaSession.microphone.desiredActive === true) {
    return 'ios_mic_session_before_js';
  }
  if (snapshot.mediaSession.available) return 'platform_before_js';
  return 'media_session_unavailable';
}

function DebugGroup({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontFamily: HIFI.fonts.mono,
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: 1,
          color: HIFI.ink3,
          marginBottom: 3,
        }}
      >
        {title}
      </div>
      {rows.map(([label, value]) => (
        <div
          key={label}
          style={{
            display: 'grid',
            gridTemplateColumns: '82px minmax(0, 1fr)',
            gap: 6,
            minWidth: 0,
            fontSize: 10,
            lineHeight: 1.35,
            marginBottom: 2,
          }}
        >
          <span style={{ color: HIFI.ink4, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {label}
          </span>
          <span
            style={{
              color: HIFI.ink2,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={value}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function formatSttChunking(
  cfg: { chunkMs: number; chunkBytes: number } | null = readSttChunkConfigFromLocation(),
): string {
  if (!cfg) return 'default';
  return `${cfg.chunkMs}ms ~${cfg.chunkBytes}B`;
}

function boolLabel(value: boolean): string {
  return value ? 'true' : 'false';
}

function nullableBoolLabel(value: boolean | null): string {
  return value === null ? 'n/a' : boolLabel(value);
}

function formatNullable(value: string | number | null): string {
  return value === null ? 'n/a' : String(value);
}

function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(2);
}

function formatSrc(src: string | null): string {
  if (!src) return 'none';
  if (src.length <= 58) return src;
  return `${src.slice(0, 46)}... (${src.length} chars)`;
}

function formatActionHandlers(
  handlers: ReturnType<typeof getMediaSessionDebugSnapshot>['actionHandlers'],
): string {
  return Object.entries(handlers)
    .map(([action, status]) => `${action}:${status}`)
    .join(' ');
}

function formatMicrophoneDebug(
  microphone: ReturnType<typeof getMediaSessionDebugSnapshot>['microphone'],
): string {
  const availability = microphone.available ? 'available' : 'missing';
  const desired = microphone.desiredActive === null ? 'n/a' : boolLabel(microphone.desiredActive);
  const last = microphone.lastSetActive === null ? 'n/a' : boolLabel(microphone.lastSetActive);
  const error = microphone.error ? ` error=${microphone.error}` : '';
  return `${availability} status=${microphone.status} desired=${desired} last=${last}${error}`;
}

function formatLastMediaAction(
  action: ReturnType<typeof getMediaSessionDebugSnapshot>['actions']['last'],
): string {
  if (!action) return 'none';
  return `${action.action} #${action.count} ${action.result} state=${action.state} ${formatAge(
    action.ageMs,
  )} ago`;
}

function formatLastKeeperEvent(
  event: ReturnType<typeof getMediaSessionKeeperDebugSnapshot>['events']['last'],
): string {
  if (!event) return 'none';
  return `${event.type} ${formatAge(event.ageMs)} ago`;
}

function formatAge(ageMs: number): string {
  if (ageMs < 1000) return `${Math.round(ageMs)}ms`;
  return `${(ageMs / 1000).toFixed(1)}s`;
}

function formatRemoteSrcObject(
  srcObject: ReturnType<typeof getRemoteTtsAudioDebugSnapshot>['srcObject'],
): string {
  if (!srcObject) return 'none';
  const tracks = srcObject.audioTrackStates.length ? ` ${srcObject.audioTrackStates.join(',')}` : '';
  return `${srcObject.type} audio=${srcObject.audioTrackCount ?? 'n/a'} live=${
    srcObject.liveAudioTrackCount ?? 'n/a'
  }${tracks}`;
}

interface CaptionData {
  label: string;
  color: string;
  text: string | null;
  live: boolean;
}

function pickCaption({
  state,
  stateColor,
  liveText,
  isTranscribing,
  lastTurn,
  accentRec,
}: {
  state: DrivingState;
  stateColor: string;
  liveText: string;
  isTranscribing: boolean;
  lastTurn: { who: 'user' | 'ai'; text: string } | null;
  accentRec: string;
}): CaptionData {
  if (state === 'recording') {
    return {
      label: 'YOU · LIVE',
      color: accentRec,
      // liveText is populated by daemon STT progress when available.
      text: liveText || null,
      live: true,
    };
  }
  if (state === 'ai') {
    return { label: 'AI · READING ALOUD', color: stateColor, text: liveText || null, live: true };
  }
  if (state === 'thinking') {
    return {
      label: isTranscribing ? 'TRANSCRIBING · OPENCLAW' : 'THINKING',
      color: stateColor,
      text: liveText || null,
      live: isTranscribing,
    };
  }
  if (lastTurn) {
    return {
      label: lastTurn.who === 'user' ? 'YOU · LAST' : 'AI · LAST',
      color: HIFI.ink3,
      text: lastTurn.text || null,
      live: false,
    };
  }
  return {
    label: 'READY',
    color: HIFI.ink3,
    text: null,
    live: false,
  };
}

function buildHeaderLabel({
  sessionId,
  hostPeerId,
}: {
  sessionId?: string;
  hostPeerId?: string | null;
}): string {
  const parts: string[] = [];
  if (sessionId) parts.push(compactValue(sessionId));
  if (hostPeerId) parts.push(compactValue(hostPeerId));
  const parsedApp = sessionId?.split(':')[2]?.trim();
  if (parsedApp) parts.push(parsedApp);
  return parts.join(' · ');
}

function compactValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

function Caption({
  caption,
  baseFont,
  error,
  daemonConnected,
  hasRtcClient,
  rtcStatus,
  compact = false,
}: {
  caption: CaptionData;
  baseFont: string;
  error: string | null;
  daemonConnected: boolean;
  hasRtcClient: boolean;
  rtcStatus: string;
  compact?: boolean;
}) {
  // Everything (STT, chat, TTS) terminates on the daemon. Surface the
  // daemon connection state first, then whatever runtime error the loop
  // reports.
  const isDaemonBlocker =
    !daemonConnected && (error === 'daemon_not_connected' || !hasRtcClient || rtcStatus !== 'open');
  const errorMessage = isDaemonBlocker
    ? hasRtcClient
      ? `CONNECTING TO DAEMON · ${rtcStatus.toUpperCase()}`
      : 'NO DAEMON — OPEN A DAEMON JOIN URL TO ENABLE TRANSCRIPTION'
    : error
      ? errorLabelFor(error)
      : null;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [caption.text]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          fontFamily: HIFI.fonts.mono,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 1.6,
          color: caption.color,
          marginBottom: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}
      >
        {caption.live && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: caption.color,
              animation: 'pulseDot 1.2s ease-in-out infinite',
              boxShadow: `0 0 6px ${caption.color}`,
            }}
          />
        )}
        <span style={{ flex: 1 }}>{caption.label}</span>
      </div>
      <div
        ref={scrollRef}
        className="transcript-scroll"
        style={{
          fontSize: 16,
          lineHeight: 1.5,
          color: HIFI.ink,
          fontWeight: 400,
          fontFamily: baseFont,
          wordBreak: 'break-word',
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          paddingRight: 10,
          borderRight: `1px solid ${HIFI.stroke}`,
        }}
      >
        {caption.text}
        {caption.live && caption.text && (
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 16,
              background: caption.color,
              marginLeft: 2,
              verticalAlign: 'text-bottom',
              animation: 'caret 0.9s step-end infinite',
            }}
          />
        )}
      </div>
      {errorMessage && (
        <div
          style={{
            marginTop: 10,
            fontFamily: HIFI.fonts.mono,
            fontSize: 10,
            letterSpacing: 1,
            color: '#ef6155',
            fontWeight: 600,
            minWidth: 0,
            maxWidth: '100%',
            maxHeight: compact ? 32 : 36,
            overflow: 'hidden',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
            flexShrink: 0,
          }}
        >
          {errorMessage}
        </div>
      )}
    </div>
  );
}

function errorLabelFor(code: string): string {
  if (code === 'daemon_not_connected') return 'DAEMON NOT CONNECTED';
  if (code === 'mic_denied') return 'MIC PERMISSION DENIED';
  if (code === 'empty_transcript') return 'NO SPEECH DETECTED — TRY AGAIN';
  if (code === 'empty_audio') return 'NO AUDIO CAPTURED — TRY AGAIN';
  if (code === 'media_recorder_unsupported')
    return 'AUDIO CAPTURE UNSUPPORTED ON THIS BROWSER';
  if (code === 'audio_unsupported') return 'AUDIO PLAYBACK UNSUPPORTED ON THIS BROWSER';
  // Daemon-originated codes from transcription / chat / TTS upstreams.
  if (code.startsWith('xai_http_')) return `DAEMON · XAI ${code.replace('xai_http_', 'HTTP ')}`;
  if (code.startsWith('xai_tts_')) return `DAEMON · XAI TTS · ${code.replace('xai_tts_', '')}`;
  if (code === 'xai_empty_reply') return 'DAEMON · XAI EMPTY REPLY';
  return `VOICE ERROR · ${code}`;
}

function PTTButton({
  onTap,
  onToggleHoldMusicMuted,
  holdMusicMuted,
  state,
  stateColor,
  stateGlow,
  label,
  accentRec: _accentRec,
  size,
}: {
  onTap: () => void;
  onToggleHoldMusicMuted: () => void;
  holdMusicMuted: boolean;
  state: DrivingState;
  stateColor: string;
  stateGlow: string;
  label: string;
  accentRec: string;
  size: string;
}) {
  const [pressed, setPressed] = useState(false);
  const clickHandledByPointerRef = useRef(false);
  const disabled = state === 'thinking';

  const isIdle = state === 'idle';
  const isRec = state === 'recording';
  const isAI = state === 'ai';
  const isThink = state === 'thinking';

  const pressScale = pressed ? 0.94 : isRec ? 1.02 : 1;

  return (
    <button
      type="button"
      aria-label={
        isThink
          ? holdMusicMuted
            ? 'Unmute hold music'
            : 'Mute hold music'
          : label
      }
      onClick={() => {
        if (isThink) {
          onToggleHoldMusicMuted();
          return;
        }
        if (disabled) return;
        const handledByPointer = clickHandledByPointerRef.current;
        clickHandledByPointerRef.current = false;
        if (!handledByPointer) {
          void unlockDaemonTtsAudio();
          playPttPressTone();
        }
        try {
          navigator.vibrate && navigator.vibrate(18);
        } catch {
          // vibration unsupported — fine
        }
        onTap();
      }}
      onPointerDown={() => {
        if (isThink) {
          setPressed(true);
          return;
        }
        if (disabled) return;
        clickHandledByPointerRef.current = true;
        void unlockDaemonTtsAudio();
        playPttPressTone();
        setPressed(true);
      }}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => {
        clickHandledByPointerRef.current = false;
        setPressed(false);
      }}
      style={{
        position: 'relative',
        width: size,
        height: size,
        aspectRatio: '1 / 1',
        flexShrink: 0,
        borderRadius: '50%',
        border: 'none',
        cursor: disabled && !isThink ? 'default' : 'pointer',
        background: isIdle
          ? `radial-gradient(circle at 30% 28%, ${pressed ? '#2a2a2e' : '#1a1a1d'} 0%, #0a0a0b 100%)`
          : `radial-gradient(circle at 30% 28%, ${stateColor} 0%, ${stateColor}88 100%)`,
        boxShadow: isIdle
          ? `0 0 0 1px ${HIFI.strokeStrong}, inset 0 1px 0 rgba(255,255,255,0.06), 0 ${pressed ? 8 : 18}px ${pressed ? 20 : 40}px rgba(0,0,0,0.6)`
          : `0 0 0 1px ${stateColor}66, 0 0 ${pressed ? 60 : 44}px ${stateGlow}, inset 0 1px 0 rgba(255,255,255,0.15)`,
        color: isIdle ? HIFI.ink : '#000',
        fontFamily: HIFI.fonts.mono,
        transform: `scale(${pressScale})`,
        transition: pressed
          ? 'transform 60ms cubic-bezier(0.4,0,1,1), box-shadow 60ms'
          : 'transform 240ms cubic-bezier(0.2,1.4,0.4,1), box-shadow 240ms, background 300ms',
        outline: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <ButtonAura active={isRec || isAI} color={stateColor} />
      <div style={{ position: 'relative', zIndex: 2, textAlign: 'center' }}>
        <div style={{ fontSize: 48, lineHeight: 1, fontWeight: 500 }}>
          {isRec ? '■' : isAI ? '◉' : isThink ? (holdMusicMuted ? '🔇' : '🔊') : '●'}
        </div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1.8,
            marginTop: 12,
          }}
        >
          {label}
        </div>
      </div>
    </button>
  );
}

function FooterButton({
  icon,
  label,
  onClick,
  compact,
}: {
  icon: string;
  label: string;
  onClick?: () => void;
  compact?: boolean;
}) {
  const disabled = !onClick;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        height: compact ? 50 : 60,
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        borderRadius: 14,
        border: `1px solid ${HIFI.stroke}`,
        background: HIFI.surface,
        color: disabled ? HIFI.ink4 : HIFI.ink,
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        fontFamily: HIFI.fonts.mono,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1.4,
        transition: 'background 0.2s, border-color 0.2s',
        appearance: 'none',
        WebkitAppearance: 'none',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span style={{ fontSize: 18, fontFamily: HIFI.fonts.sans }}>{icon}</span>
      {label}
    </button>
  );
}
