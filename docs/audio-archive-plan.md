# Audio Archive Plan for Clawkie Talkie Daemon

## Goal

Persist all incoming (STT) and outgoing (TTS) audio per voice session to disk, organized for later retrieval, playback, and debugging.

---

## Current Audio Flow

### Incoming Audio (Phone → Daemon)

1. Phone captures mic audio as PCM16LE mono @ 16 kHz
2. Audio is sent over WebRTC DataChannel as binary frames
3. `VoiceSession.handlePeerData()` receives binary data and forwards it to `SttSession.sendAudio()`
4. `OpenClawInferSttSession` accumulates PCM chunks in `this.chunks[]`, writes a temp WAV for infer transcription, then deletes the temp dir
5. **Audio is not persisted anywhere** — it lives only in memory during the turn

### Outgoing Audio (Daemon → Phone)

1. `OpenClawInferTtsSession` synthesizes reply text to a temp MP3 via OpenClaw infer
2. MP3 is decoded to PCM16LE mono @ 24 kHz via ffmpeg
3. PCM is chunked into 100 ms pieces and fed to `TtsSessionCallbacks.onAudio()`
4. `VoiceSession` either sends PCM over DataChannel or feeds it to the WebRTC audio track (RTCAudioSource)
5. `VoiceSession.ttsAudioTurn` retains a canonical PCM log per turn for reconnect replay, capped at 64 MB, then discarded
6. **Audio is not persisted anywhere** — temp MP3 is deleted after the turn

---

## Proposed Architecture

### 1. Archive Directory Structure

```
<archive-root>/sessions/<sessionId>/
  meta.json              # session metadata (room ID, start time, channel, etc.)
  incoming/
    turn-001.wav         # full-turn incoming PCM as WAV
    turn-002.wav
    ...
  outgoing/
    turn-001.mp3         # synthesized reply MP3
    turn-001.wav         # decoded PCM (optional, derived from MP3)
    turn-002.mp3
    ...
  transcript.jsonl       # per-turn transcript log (incoming text, reply text, timestamps)
```

- `<archive-root>`: configurable via CLI flag `--archive-dir` and/or env `CLAWKIE_ARCHIVE_DIR`
- Default: `~/.openclaw/clawkie-archive/` (or alongside the daemon's data directory)
- Session ID is the existing `sessionId` from `VoiceSessionConfig`

### 2. Archive Manager (`daemon/src/audioArchive.ts`)

A new module that owns all disk writes. Responsibilities:

- **Create session archive dir** on first audio for a session (lazy init)
- **Write incoming WAV** per STT turn — receives raw PCM16 buffer + sample rate, wraps with WAV header using existing `pcm16ToWavBuffer()` from `audio.ts`
- **Write outgoing MP3** per TTS turn — receives the temp MP3 path and copies it to the archive before cleanup
- **Append transcript log** — JSONL with `{ turnId, timestamp, direction, text }` entries
- **Write meta.json** — session start time, room ID, channel, target, session key
- **Clean up** on session close — finalize metadata, mark session ended

```typescript
export interface AudioArchiveConfig {
  archiveDir: string;
  enabled: boolean;
}

export class AudioArchive {
  constructor(config: AudioArchiveConfig);

  // Called when a voice session starts
  initSession(sessionId: string, meta: SessionMeta): Promise<void>;

  // Called when STT turn completes (full PCM available)
  saveIncomingAudio(sessionId: string, turnId: number, pcm: Buffer, sampleRate: number): Promise<void>;

  // Called when TTS synthesis completes (MP3 file ready)
  saveOutgoingAudio(sessionId: string, turnId: number, mp3Path: string): Promise<void>;

  // Called for each transcript entry
  appendTranscript(sessionId: string, entry: TranscriptEntry): Promise<void>;

  // Called when session closes
  finalizeSession(sessionId: string): Promise<void>;
}
```

### 3. Integration Points

#### 3a. Incoming Audio (STT)

**Where:** `OpenClawInferSttSession.signalAudioDone()`

Currently: PCM is concatenated, written to temp WAV, transcribed, temp dir deleted.

**Change:** Before cleanup, pass the concatenated PCM buffer to the archive manager.

- In `VoiceSession`, after `sttDone` callback fires (or inside the STT session's `signalAudioDone`), call `archive.saveIncomingAudio(sessionId, turnId, pcm, sampleRate)`
- The archive writes a WAV file to `incoming/turn-NNN.wav`
- No change to the STT pipeline itself — archive is a side effect after transcription

**Alternative (simpler):** Hook into `VoiceSession` rather than `OpenClawInferSttSession`. The `VoiceSession` already has access to `sessionId` and the turn token. Add an archive callback in the STT session callbacks:

```typescript
// In VoiceSession, when creating STT callbacks:
onDone: (text) => {
  // ... existing code ...
  void this.archive?.saveIncomingAudio(this.opts.sessionId, token, sttPcm, STT_SAMPLE_RATE);
}
```

Challenge: the raw PCM is inside `OpenClawInferSttSession.chunks[]`. Options:
- **Option A:** Expose the concatenated PCM via a new callback `onAudioComplete(pcm: Buffer)` in `SttSessionCallbacks`
- **Option B:** Have `OpenClawInferSttSession` accept an optional `archiveSink` in its options
- **Recommended: Option A** — keeps the archive concern out of the STT session

#### 3b. Outgoing Audio (TTS)

**Where:** `OpenClawInferTtsSession.run()`

Currently: MP3 is written to temp dir, decoded to PCM, temp dir deleted.

**Change:** Copy the MP3 to the archive before temp dir cleanup.

- In `VoiceSession`, when creating TTS callbacks, add an archive hook in `onDone`:
  ```typescript
  onDone: () => {
    // ... existing code ...
    void this.archive?.saveOutgoingAudio(this.opts.sessionId, token, mp3TempPath);
  }
  ```

- Or add `onSynthesized(mp3Path: string)` callback to `TtsSessionCallbacks` that fires after synthesis but before cleanup
- The archive copies the MP3 to `outgoing/turn-NNN.mp3`

Challenge: The MP3 path is internal to `OpenClawInferTtsSession`. Options:
- **Option A:** Add `onSynthesized(mp3Path: string)` to `TtsSessionCallbacks` — fires after MP3 is ready, before decode
- **Option B:** Pass an `archiveSink` to `OpenClawInferTtsSessionOptions`
- **Recommended: Option A** — consistent with the STT approach

#### 3c. Transcript Log

**Where:** `VoiceSession.runReplyTurn()` and STT callbacks

- After STT `onDone(text)`, append `{ turnId, direction: "incoming", text, timestamp }` to `transcript.jsonl`
- After `replyDone(replyText)`, append `{ turnId, direction: "outgoing", text, timestamp }` to `transcript.jsonl`

#### 3d. Session Lifecycle

- **Init:** When `VoiceSession` constructor runs (or on first peer connect), call `archive.initSession(sessionId, meta)`
- **Finalize:** In `VoiceSession.close()`, call `archive.finalizeSession(sessionId)`

### 4. Configuration

Add CLI flag and env var:

```
--archive-dir <path>     # Set archive root directory
--no-archive             # Disable archiving (default: enabled if archive-dir set)
```

Env:
```
CLAWKIE_ARCHIVE_DIR=/path/to/archive
CLAWKIE_ARCHIVE_ENABLED=true|false
```

Config in `VoiceSessionRuntimeOptions`:
```typescript
archive?: AudioArchive | null;
```

### 5. Disk Management

- **Rotation:** Configurable max archive age (default: 30 days). A sweep job on daemon startup deletes session dirs older than the threshold.
- **Size cap:** Configurable max total archive size (default: 1 GB). Oldest sessions pruned first.
- **Per-session cap:** No individual session should exceed ~100 MB (safety valve for very long sessions).

### 6. Privacy & Security

- Archive contains voice audio — treat as sensitive data
- Archive dir should have `0700` permissions
- No audio is sent anywhere — purely local disk
- Configurable retention to avoid indefinite growth
- Optional: encryption at rest (future enhancement)

### 7. Testing Strategy

- Unit tests for `AudioArchive` class (mock filesystem)
- Integration test: simulate a full STT→reply→TTS turn and verify archive files exist
- Test: disabled archiving produces no files
- Test: session close finalizes metadata
- Test: concurrent sessions don't interfere

### 8. Implementation Phases

**Phase 1 — Core Archive Module**
- Create `audioArchive.ts` with the `AudioArchive` class
- WAV writing for incoming PCM
- MP3 copying for outgoing audio
- Transcript JSONL append
- Session init/finalize

**Phase 2 — STT Integration**
- Add `onAudioComplete(pcm: Buffer)` callback to `SttSessionCallbacks`
- Wire up in `VoiceSession` STT callbacks
- Pass PCM to archive after transcription

**Phase 3 — TTS Integration**
- Add `onSynthesized(mp3Path: string)` callback to `TtsSessionCallbacks`
- Wire up in `VoiceSession` TTS callbacks
- Copy MP3 to archive before temp cleanup

**Phase 4 — Configuration & CLI**
- CLI flags (`--archive-dir`, `--no-archive`)
- Env vars (`CLAWKIE_ARCHIVE_DIR`, `CLAWKIE_ARCHIVE_ENABLED`)
- Wire into daemon CLI (`cli.ts`) and `VoiceSessionRuntimeOptions`

**Phase 5 — Transcript Logging**
- Append incoming transcript after STT done
- Append outgoing transcript after reply done
- Include timestamps and turn IDs

**Phase 6 — Disk Management**
- Startup sweep for expired sessions
- Size cap enforcement
- Per-session size safety valve

**Phase 7 — Testing**
- Unit tests for archive module
- Integration test for full turn cycle
- Disabled-archive test

---

## Open Questions

1. **Should the archive also save partial STT transcripts?** Probably not — the final transcript is authoritative. But we could log partials in the transcript JSONL for debugging.

2. **Should outgoing WAV be saved alongside MP3?** The MP3 is the source format from infer. WAV can be derived. Saving both doubles disk usage. Recommendation: MP3 only, with a `--archive-wav` flag for those who want both.

3. **Should the archive be per-daemon or per-session?** Per-session (one dir per session ID). A daemon running multiple concurrent sessions will have multiple active archive dirs.

4. **Naming convention for turn files?** Zero-padded sequential (`turn-001.wav`) is simple and sortable. Alternative: timestamp-based (`20260629-103201.wav`) but harder to correlate with turn IDs.

5. **Should archiving be opt-in or opt-out?** Recommendation: opt-in (disabled by default) to avoid surprising disk usage. Enable with `--archive-dir` flag.