# Clawkie Talkie — Android

Native Android port of the Clawkie Talkie web client (`client/`). Same
product, same protocol, same design: a walkie-talkie voice surface for an
existing OpenClaw session, talking to the same local daemon through the same
rambly-style signaling broker and WebRTC data channel.

The web client remains the source of truth. Every layer here is a 1:1 mirror
of a web-client module:

| Android | Mirrors (web) |
| --- | --- |
| `protocol/Protocol.kt` | `client/src/voice/protocol.ts` |
| `rtc/SignalClient.kt` | `client/src/rtc/signal.ts` (SSE subscribe + HTTP POST) |
| `rtc/SignalKind.kt` | `client/src/rtc/signalKind.ts` |
| `rtc/RtcClient.kt` | `client/src/rtc/client.ts` (simple-peer non-initiator) |
| `rtc/RtcSession.kt` | `client/src/rtc/RtcContext.tsx` (negotiation, rendezvous, catalogs, retry) |
| `voice/DrivingReducer.kt` | `client/src/voice/drivingReducer.ts` |
| `voice/DrivingLoop.kt` | `client/src/voice/drivingLoop.ts` (incl. snapshot replay planning) |
| `voice/SttDaemon.kt` / `AudioSource.kt` | `client/src/voice/sttDaemon.ts` / `audioSource.ts` (16 kHz PCM16LE, 1024-sample frames) |
| `voice/TtsPlayer.kt` / `Replay.kt` | `client/src/voice/tts.ts` / `replay.ts` |
| `voice/HoldMusic.kt` | `client/src/voice/holdMusic.ts` + `holdMusicCatalog.ts` |
| `voice/AudioBands.kt` | `client/src/voice/audioBands.ts` |
| `voice/HandoffUrl.kt` / `VoiceRoom.kt` | `client/src/voice/handoffUrl.ts` / `rtc/voiceRoom.ts` |
| `storage/Storage.kt` | `client/src/storage.ts` (same keys/JSON shapes, on SharedPreferences) |
| `ui/*` | `client/src/screens/*`, `components/*`, `tokens.ts`, `styles.css` |

## How it connects

Identical to the browser: the app joins the signaling room named by the
daemon's `host` peer ID (SSE subscribe + HTTP POST against
`https://api.rambly.app` by default), waits for the daemon's SDP offer,
answers as a non-initiator, then speaks protocol v1 over the data channel
(`client.hello` → `daemon.hello` → `rendezvous.join` → per-session voice
room). Mic audio is PCM16LE mono 16 kHz binary frames on the data channel;
the daemon's TTS reply arrives as a remote WebRTC audio track with a
data-channel PCM fallback. The compatibility invariant holds: a newer app
degrades gracefully against an older daemon (capability negotiation with a
250 ms legacy fallback, `daemon.unsupported` surfacing, additive features
only).

## Headset / AirPods button

While the voice (driving) screen is open, the app holds an active Android
`MediaSession`, so a Bluetooth headset's primary media button is routed to
Clawkie and triggers the **same action callback as the big on-screen
button** — identical semantics per state:

- idle → start recording
- recording → stop recording (turn goes to the agent)
- reading reply / replay → silence the response
- thinking → toggle hold-music mute

What this maps to physically: the AirPods stem single press (play/pause),
and any headset sending `KEYCODE_MEDIA_PLAY`, `KEYCODE_MEDIA_PAUSE`,
`KEYCODE_MEDIA_PLAY_PAUSE`, or `KEYCODE_HEADSETHOOK` (wired inline remotes
included). Deliberately **not** handled: double/triple press
(next/previous track) and volume keys — they're ignored rather than
remapped. AirPods long-press (Siri / noise control) is handled inside the
AirPods/iOS pairing layer and never reaches Android, so it cannot be
supported.

Scope: the session exists only while the voice screen is composed. While
it's up it takes media-button priority over background players (that's the
point in the car); leaving the screen releases the session and buttons
return to the previous owner. Background music apps' *playback* is not
touched either way — only the button routing.

Manual test: pair a headset, open a voice link, press the stem once per
state and watch the screen mirror the on-screen button (REC → THINKING →
mute toggle → silence reply). Each accepted press also plays the PTT
confirmation tone.

## Host entry

The web client receives its daemon host through the page URL — the browser's
address bar is its host-entry and host-switch mechanism. Android has no
address bar, so the app adds the platform equivalent:

- A fresh install (no saved host, no deep link, no build default) opens a
  **host entry screen** asking for the daemon's host ID (`DAEMON_PEER_ID`).
  Connecting stores it as the last dashboard host and opens the dashboard.
- The dashboard's daemon-connection card has a **SWITCH HOST** pill (always
  available, including while disconnected).
- Settings → TECHNICAL → Host ID has a **CHANGE** button.
- Dismissing a dead-link error with no host to fall back to also lands on
  host entry instead of a dead screen.

Host precedence stays: deep-link `host=` > saved last host > build-time
`ct.defaultHostId` > prompt.

## Links

The app registers for the same URLs the web client serves:

- `https://clawkietalkie.app/voice#host=<daemon>&session=<id>&sessionKey=…&channel=…&target=…`
- `https://clawkietalkie.app/dashboard#host=<daemon>`

Launching from the home screen recovers the last dashboard host (the PWA
relaunch path). Debug link params are honored too: `?debug=true` (audio
debug panel), `?sttChunkMs=<ms>` (PCM batching), `?audio-fixture=<url>`
(deterministic capture source).

Note: `android:autoVerify` App Links require an `assetlinks.json` on
clawkietalkie.app to open without a chooser; until that's published, Android
shows the app/browser disambiguation sheet.

## Hold music

The baked Low/Medium/High processed + original tracks (~190 MB total) are
streamed from the hosted origin (`https://clawkietalkie.app/music*`) through
a 256 MB on-device cache instead of being bundled into the APK. Playback
behavior mirrors the web: processed and original players run in sync with
only one audible, shuffled deck with no immediate repeats, random start
offset, instant effects toggle, per-track disable, and mute that keeps the
bed (and visualizer) alive.

## Build

```bash
cd android
./gradlew :app:assembleDebug      # APK at app/build/outputs/apk/debug/
./gradlew :app:testDebugUnitTest  # reducer/protocol/routing/fixture tests
```

Gradle 8.13 needs a JVM 17–23. `gradlew` handles this itself: if the active
JVM is outside that range (e.g. a system Java 26), it falls back to the
first compatible JDK it finds (`CT_JAVA_HOME`, mise installs, `/usr/lib/jvm`,
Homebrew) and prints which one it picked; it only fails — with install
instructions — when none exists. `local.properties` needs `sdk.dir`
pointing at an Android SDK with platform 35 + build-tools 35.

## Verification status

Verified end-to-end on a Pixel 7 emulator (API 35, KVM) against a live
daemon through the production rambly signaling broker:

- signaling rendezvous, daemon-initiated offer/answer/ICE, data channel up;
- protocol negotiation (`client.hello` → `daemon.hello`), recent-sessions
  subscription, live dashboard with real OpenClaw sessions;
- old-daemon graceful degradation (a pre-`client.hello` daemon answers
  `unexpected_message` and times rendezvous out; the app stays in legacy
  mode and reconnects, same as the web client);
- session select → `rendezvous.join` → voice-room flip → Driving screen
  with restored assistant preview;
- daemon TTS audio track attached with live sink frames (debug panel:
  `trackState=LIVE`, frame age ~43 ms);
- full voice turn with the deterministic fixture: recording state, PCM16
  frames over the data channel, real OpenClaw STT transcript rendered
  ("Hi!"), thinking state with streamed hold music + live waveform +
  track label, and daemon error surfacing
  (`VOICE ERROR · openclaw_delivery_unresolved` for a route-less session).

Still unproven (needs a human run, ~1 minute):

1. Open a voice link for a session with a real reply route (any session in
   the dashboard), tap to talk, speak, tap to stop.
2. Confirm the spoken reply plays (remote-track path), live reply text
   autoscrolls, and ↺ REPLAY replays the buffered audio.
3. Confirm the reply landed in the original thread.

This posts to the real session thread, which is why it was not automated.

Transport overrides (the web client's `VITE_*` equivalents) are Gradle
properties baked into BuildConfig:

```bash
./gradlew :app:assembleDebug \
  -Pct.signalServer=https://signal.example.com \
  -Pct.iceServersJson='[{"urls":"stun:stun.example.com:3478"}]' \
  -Pct.defaultHostId=<daemon-peer-id> \
  -Pct.webOrigin=https://clawkietalkie.app
```

## Privacy boundary

Unchanged from the web client: the phone captures mic audio and plays reply
audio; it stores only UI settings, local transcripts, and favorites. No
provider API keys and no OpenClaw credentials ever reach the device — the
daemon is the trusted side.
