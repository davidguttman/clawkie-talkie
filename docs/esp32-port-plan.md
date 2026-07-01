# ESP32 Hardware Port Plan for Clawkie Talkie

## Goal

Build a dedicated ESP32-based voice terminal for Clawkie Talkie with:
- Microphone input
- Speaker output
- Push-to-talk button or touch screen
- WiFi connectivity
- Direct WebRTC connection to the existing Node.js daemon using Espressif's `esp_peer` component

The daemon (STT, LLM, TTS) stays on a host machine or server. Only the client moves from the browser to embedded hardware.

---

## Why This Is Now Feasible

`esp_peer` from Espressif provides a full WebRTC PeerConnection implementation for ESP32, including:
- ICE, DTLS, SCTP, RTP/SRTP
- Data channels
- Audio codecs: Opus, G.711A (PCMA), G.711U (PCMU)
- Video codecs: H.264, MJPEG

This removes the biggest earlier blocker — the need to replace WebRTC with a custom lightweight transport. The ESP32 can speak the same protocol as the browser client.

---

## Recommended Hardware

| Component | Recommendation | Notes |
|-----------|---------------|-------|
| SoC | **ESP32-S3** | Required for RAM, PSRAM option, and AI vector instructions. Classic ESP32 is too tight for this. |
| RAM | 512 KB SRAM + optional 8 MB PSRAM | PSRAM useful for audio buffers and larger UI assets. |
| Microphone | I2S MEMS, e.g. INMP441 or SPH0645 | 16 kHz mono 16-bit PCM input. |
| Speaker | I2S DAC + amp, e.g. PCM5102 or MAX98357A | 16 kHz mono or stereo output. |
| UI option A | Capacitive touch screen + LVGL | Full UI comparable to the browser. |
| UI option B | Large PTT button + status LEDs/OLED | Simpler, lower power, fewer RAM demands. |
| Board | ESP32-S3-DevKitC, M5Stack CoreS3, LilyGo T-Display S3, or custom PCB | Pick based on UI choice and battery needs. |

---

## Software Stack

- **ESP-IDF v5.x**
- **esp_peer v1.2.3** — WebRTC PeerConnection
- **esp_codec_dev** or direct I2S driver — audio input/output
- **FreeRTOS** — task separation
- **LVGL** — optional touch UI
- **Node.js daemon** — unchanged except for signaling/codec handshake if needed

---

## Open Questions to Resolve First

Before implementation starts, we need answers to these questions. They determine the work size.

1. **Signaling**: How does the current daemon exchange SDP and ICE candidates with the browser?
   - HTTP endpoint?
   - WebSocket?
   - MQTT?
   - Something else?
   - The ESP32 must use the same mechanism.

2. **Audio codec mismatch**: The browser currently sends raw PCM to the daemon over a WebRTC data channel. WebRTC audio tracks typically carry compressed audio (Opus).
   - Does the daemon already support Opus decode?
   - Or should we send PCM over a WebRTC data channel using `esp_peer`'s data channel, avoiding the media track path?

3. **ICE / NAT**: Does the daemon deployment need STUN/TURN for ESP32 connections from outside the local network?

4. **Authentication / provisioning**: How does the ESP32 obtain WiFi credentials and the daemon host peer ID?
   - BLE provisioning?
   - Captive portal?
   - Hardcoded for dev?

---

## Proposed Architecture

```text
┌─────────────────────────────────────────────┐
│  ESP32-S3 terminal                            │
│  ┌─────────────────────────────────────────┐ │
│  │  UI task (button/touch + status LEDs)   │ │
│  ├─────────────────────────────────────────┤ │
│  │  Audio task                             │ │
│  │  - I2S mic → PCM ring buffer            │ │
│  │  - PCM ring buffer → I2S speaker        │ │
│  ├─────────────────────────────────────────┤ │
│  │  WebRTC task (esp_peer)                 │ │
│  │  - signaling: SDP/ICE exchange          │ │
│  │  - send mic audio via data channel      │ │
│  │  - receive TTS audio via data channel     │ │
│  │  - handle control messages              │ │
│  └─────────────────────────────────────────┘ │
└──────────────────┬────────────────────────────┘
                   │ WiFi
                   ▼
┌─────────────────────────────────────────────┐
│  Node.js daemon (existing)                  │
│  - STT, LLM, TTS                            │
│  - WebRTC signaling endpoint                │
│  - WebRTC PeerConnection                    │
└─────────────────────────────────────────────┘
```

Using a WebRTC data channel for PCM is the safest path: it avoids Opus codec changes on both sides and keeps the daemon's existing PCM pipeline intact.

---

## Phase Plan

### Phase 1 — Investigation (1–2 days)

- [ ] Document how the current browser client performs WebRTC signaling with the daemon.
- [ ] Confirm whether the daemon accepts/receives raw PCM over a WebRTC data channel or over an audio track.
- [ ] Identify any Opus/codec handling in the daemon.
- [ ] Confirm STUN/TURN requirements for the target deployment.

### Phase 2 — Prototype firmware (3–5 days)

- [ ] ESP32-S3 project setup with ESP-IDF.
- [ ] Add `esp_peer` dependency.
- [ ] I2S microphone capture at 16 kHz mono 16-bit.
- [ ] I2S speaker playback at 16 kHz mono 16-bit.
- [ ] FreeRTOS queue/ring buffer between audio and network tasks.
- [ ] Static WiFi credentials and hardcoded daemon peer ID for initial testing.

### Phase 3 — WebRTC integration (3–5 days)

- [ ] Implement signaling client on ESP32 matching the daemon's existing flow.
- [ ] Establish PeerConnection to the daemon.
- [ ] Send microphone PCM over a WebRTC data channel.
- [ ] Receive daemon PCM over a WebRTC data channel and play it.
- [ ] Map control messages (`stt.partial`, `stt.done`, `tts.start`, `tts.done`, etc.) over the same data channel.

### Phase 4 — UI and input (2–4 days)

- [ ] Add large PTT button input.
- [ ] Add status output: LED or small OLED for ready/recording/thinking/playing.
- [ ] Optional: add LVGL touch screen with a minimal PTT surface and transcript.

### Phase 5 — Provisioning and polish (2–4 days)

- [ ] WiFi provisioning (BLE or captive portal).
- [ ] Daemon host peer ID provisioning.
- [ ] Power management / battery monitoring.
- [ ] OTA update support (optional but recommended).

### Phase 6 — Testing and integration (2–3 days)

- [ ] End-to-end test: press button, speak, get agent reply played back.
- [ ] Latency and jitter measurement.
- [ ] WiFi roaming / reconnect behavior.
- [ ] Echo / feedback handling.

**Total estimated effort: 2–4 weeks** for a working prototype, depending on how much of the daemon signaling and codec path can be reused.

---

## Key Technical Decisions

| Decision | Recommended choice | Rationale |
|----------|-------------------|-----------|
| Transport | WebRTC data channel with PCM | Avoids codec changes; reuses daemon's existing PCM pipeline. |
| SoC | ESP32-S3 | Enough RAM and CPU for audio + WebRTC + simple UI. |
| Audio sample rate | 16 kHz mono 16-bit | Matches current browser client. |
| UI first | Physical PTT button + status LED | Faster and more reliable than a touch UI; add screen later. |
| Signaling first | Reuse daemon's existing signaling | Minimizes daemon changes. |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| RAM exhaustion on ESP32 | Use ESP32-S3 with PSRAM; keep ring buffers small (1–2 s each). |
| WiFi latency/jitter causing audio dropouts | Use jitter buffer on playback; tolerate 200–500 ms latency. |
| Echo/feedback from speaker to mic | Use directional mic, headphones, or a codec with hardware AEC. |
| Daemon signaling not documented | Inspect browser client and daemon source; add an endpoint if necessary. |
| esp_peer integration issues | Start from the `peer_demo` example and iterate. |
| Codec mismatch if using audio tracks | Default to data-channel PCM; add Opus later only if needed. |

---

## Deliverables

1. Working ESP32-S3 firmware that connects to the daemon and handles voice turns.
2. Minimal documentation for hardware wiring and flashing.
3. Notes on any daemon changes made for signaling or codec support.
4. Optional LVGL touch UI follow-up.

---

## Next Steps (when we start)

1. Inspect the daemon's WebRTC signaling flow (`daemon/src/rtc/`, `client/src/rtc/`).
2. Decide whether to use PCM over data channel or Opus over audio track.
3. Order or confirm ESP32-S3 hardware.
4. Create a fresh ESP-IDF project and integrate `esp_peer`.

---

*Document created: 2026-06-25*
*Status: planning — implementation not started*
