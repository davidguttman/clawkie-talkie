# OpenClaw Infer Transcription Implementation Plan

> **For Codex subagents:** REQUIRED SUB-SKILL: Use test-driven development. Implement one task only. Red test first when applicable, minimal implementation, focused tests, commit. Do not proceed to later tasks.

**Goal:** Replace Clawkie Talkie's custom xAI streaming STT websocket path with daemon-side OpenClaw `infer audio transcribe` transcription.

**Architecture:** The browser keeps sending PCM as it does today. The daemon replaces `XaiSttSession` with an `OpenClawInferSttSession` that buffers the turn audio, optionally emits committed phrase transcripts from VAD-delimited chunks, and runs a final full-turn `openclaw infer audio transcribe` pass on `stt.audio.done`. xAI STT finals are no longer authoritative; OpenClaw infer output is.

**Tech Stack:** TypeScript, Node 24, Vitest, `openclaw infer audio transcribe`, PCM16 WAV files, optional WASM VAD via `@echogarden/fvad-wasm` or `@ozymandiasthegreat/vad` only if needed after the non-native dependency smoke.

---

## Non-negotiable execution process

This branch must be implemented with subagent-driven TDD:

1. Supervisor posts/updates this plan in-thread.
2. For each task below:
   - dispatch a fresh Codex subagent for the task only;
   - subagent writes failing test first when applicable;
   - subagent implements only that slice;
   - subagent runs focused tests;
   - subagent commits only that task;
   - supervisor dispatches a fresh spec-review subagent;
   - if spec review finds gaps, implementation subagent/fix subagent fixes them and review repeats;
   - supervisor dispatches a fresh code-quality review subagent;
   - if quality review finds issues, fix and re-review;
   - supervisor independently runs focused verification before moving on.
3. Do not run multiple implementation subagents concurrently on this worktree.
4. Do not make broad rewrites. Keep current phone/daemon control protocol unless a task explicitly says otherwise.

## Branch and worktree

- Branch: `switch/openclaw-infer-transcription`
- Worktree: `/mnt/data/play/web/clawkie-talkie/.worktrees/switch-openclaw-infer-transcription`
- Project root: `/mnt/data/play/web/clawkie-talkie`

## Current relevant files

- `daemon/src/voiceSession.ts`
  - imports `XaiSttSession`
  - opens it in `openStt()`
  - forwards binary PCM frames with `this.stt.sendAudio(bytes)`
  - forwards `stt.audio.done` to `this.stt?.signalAudioDone()`
  - starts reply turn from `onDone(text)`
- `daemon/src/sttSession.ts`
  - custom xAI websocket STT implementation and xAI event cleanup helpers
- `daemon/src/audio.ts`
  - PCM helper home; currently has resampling and frame slicing helpers
- `test/sttHandler.test.ts`
  - tests xAI event cleanup behavior; should become obsolete or stay only if legacy helpers remain
- `test/voiceSession.test.ts`
  - good place for voice-session wiring tests
- `test/sttDaemon.test.ts`
  - client-side control/audio-done behavior should remain unchanged

## Desired runtime behavior

- On `stt.start`:
  - reset turn as today;
  - create OpenClaw infer STT session;
  - send `stt.ready` promptly so the browser starts/continues sending PCM.
- On binary audio frames:
  - append PCM bytes to the current turn buffer;
  - optionally feed chunker/VAD for committed phrase transcripts.
- On `stt.audio.done`:
  - flush pending chunk state;
  - write full-turn PCM to temp WAV;
  - run `openclaw infer audio transcribe --file <wav> --json` by default;
  - include `--language <code>` when `opts.sttLanguage` exists;
  - include `--model <provider/model>` only if a project/env override is configured later, not hardcoded;
  - parse first `outputs[].text`;
  - emit `stt.done` with final transcript;
  - call `runReplyTurn(finalTranscript)` as today.
- If infer fails:
  - emit `stt.error` with stable code like `openclaw_infer_stt_failed`;
  - reset turn, no reply turn.
- If transcript is empty:
  - preserve current `empty_transcript` path.
- Do not require `XAI_API_KEY` for STT. xAI may still be used elsewhere for chat/TTS until separately changed.

---

## Task 1: WAV writer and infer command runner

**Files:**
- Modify: `daemon/src/audio.ts`
- Create: `daemon/src/openclawInfer.ts`
- Test: `test/openclawInfer.test.ts`

**Step 1: Write failing tests**

Add tests for:

1. `pcm16ToWavBuffer(pcm, 16000)` returns a valid mono PCM16 WAV header:
   - starts with `RIFF`
   - contains `WAVE`
   - sample rate is 16000
   - bits per sample is 16
   - data chunk length equals PCM byte length
2. `buildInferTranscribeCommand({ filePath, language })` returns:
   - command `openclaw`
   - args: `['infer', 'audio', 'transcribe', '--file', filePath, '--json']`
   - appends `--language en` when provided
3. `parseInferTranscript(stdout)` extracts `outputs[0].text` from the stable JSON envelope.
4. `parseInferTranscript(stdout)` throws a clear error when `ok: false`, invalid JSON, or no transcript text.

Run:

```bash
npm test -- test/openclawInfer.test.ts
```

Expected before implementation: FAIL because functions/files do not exist.

**Step 2: Implement minimal code**

- Add `pcm16ToWavBuffer(pcm: Buffer, sampleRate: number): Buffer` to `daemon/src/audio.ts`.
- Add pure helpers to `daemon/src/openclawInfer.ts`:
  - `buildInferTranscribeCommand(opts)`
  - `parseInferTranscript(stdout)`
- No child process execution yet in this task.

**Step 3: Verify**

```bash
npm test -- test/openclawInfer.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add daemon/src/audio.ts daemon/src/openclawInfer.ts test/openclawInfer.test.ts
git commit -m "test: add OpenClaw infer transcription primitives"
```

---

## Task 2: Executable OpenClaw infer transcription runner

**Files:**
- Modify: `daemon/src/openclawInfer.ts`
- Test: `test/openclawInfer.test.ts`

**Step 1: Write failing tests**

Add tests with injected fake exec function:

1. `transcribeWithOpenClawInfer({ wavPath })` calls the command from Task 1.
2. It returns parsed transcript text on success.
3. It passes `--language` when language is provided.
4. It maps exec failures/stderr to an `OpenClawInferError` or stable error message containing `openclaw_infer_stt_failed`.
5. It supports `AbortSignal` by passing it to the exec layer.

Run:

```bash
npm test -- test/openclawInfer.test.ts
```

Expected before implementation: FAIL because executable runner does not exist.

**Step 2: Implement minimal code**

- Use `node:child_process` `execFile` or `spawn` behind an injectable adapter.
- Keep stdout parsing separate from process execution.
- Do not shell-concatenate command strings.
- Do not hardcode OpenAI or xAI model; use the currently configured OpenClaw audio provider unless a function option explicitly supplies a model.

**Step 3: Verify**

```bash
npm test -- test/openclawInfer.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add daemon/src/openclawInfer.ts test/openclawInfer.test.ts
git commit -m "feat: add OpenClaw infer transcription runner"
```

---

## Task 3: Full-turn OpenClaw infer STT session

**Files:**
- Create: `daemon/src/inferSttSession.ts`
- Test: `test/inferSttSession.test.ts`

**Step 1: Write failing tests**

Use fake transcriber and fake temp-file/wav writer hooks where useful. Test:

1. Constructor/on start fires `onReady` promptly.
2. `sendAudio()` buffers multiple PCM chunks exactly in order.
3. `signalAudioDone()` writes one full-turn WAV and calls infer once.
4. Successful infer calls `onDone(text)` and then `onClosed()` or equivalent lifecycle callback consistent with existing voice-session expectations.
5. Empty transcript calls `onDone('')` or propagates empty text so existing `runReplyTurn` handles `empty_transcript`; choose one behavior and document it in test.
6. Infer failure calls `onError('openclaw_infer_stt_failed')` and closes.
7. `close()` aborts in-flight infer and suppresses later callbacks.

Run:

```bash
npm test -- test/inferSttSession.test.ts
```

Expected before implementation: FAIL because session does not exist.

**Step 2: Implement minimal code**

`OpenClawInferSttSession` should expose the same small surface `voiceSession.ts` currently needs:

```ts
sendAudio(bytes: Uint8Array): void
signalAudioDone(): void
close(): void
```

Callbacks should mirror `SttSessionCallbacks` enough for `voiceSession.ts`:

```ts
onReady()
onPartial(text, isFinal) // can be unused in full-turn-only mode
onDone(text)
onError(message)
onClosed()
```

Implementation detail:

- create temp dir under OS temp;
- write `turn.wav` with `pcm16ToWavBuffer`;
- call `transcribeWithOpenClawInfer({ wavPath, language })`;
- cleanup temp files best-effort;
- guard all callbacks after close/abort.

**Step 3: Verify**

```bash
npm test -- test/inferSttSession.test.ts test/openclawInfer.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add daemon/src/inferSttSession.ts test/inferSttSession.test.ts
git commit -m "feat: add full-turn OpenClaw infer STT session"
```

---

## Task 4: Wire voice session away from xAI STT

**Files:**
- Modify: `daemon/src/voiceSession.ts`
- Test: `test/voiceSession.test.ts`

**Step 1: Write failing tests**

Add/adjust tests so voice session behavior proves:

1. `stt.start` opens `OpenClawInferSttSession`, not `XaiSttSession`.
2. binary PCM frames are forwarded to the new session.
3. `stt.audio.done` calls the new session's `signalAudioDone()`.
4. `onDone('hello')` still sends `stt.done`, then starts reply turn exactly as before.
5. `onError('openclaw_infer_stt_failed')` sends `stt.error` and resets the turn.

Use dependency injection if needed so the test can install a fake STT session factory without invoking real `openclaw`.

Run:

```bash
npm test -- test/voiceSession.test.ts
```

Expected before implementation: FAIL because `voiceSession.ts` still imports/constructs `XaiSttSession`.

**Step 2: Implement minimal code**

- Replace the `XaiSttSession` import with `OpenClawInferSttSession`.
- Prefer a tiny `SttSessionLike` interface and optional factory injection for tests.
- Update log lines/comments from xAI-specific to OpenClaw infer-specific.
- Do not change client protocol.
- Do not touch chat/TTS behavior.

**Step 3: Verify**

```bash
npm test -- test/voiceSession.test.ts test/inferSttSession.test.ts test/openclawInfer.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add daemon/src/voiceSession.ts test/voiceSession.test.ts
git commit -m "feat: route voice STT through OpenClaw infer"
```

---

## Task 5: Remove or quarantine xAI STT-specific cleanup code

**Files:**
- Modify or delete: `daemon/src/sttSession.ts`
- Modify or delete: `test/sttHandler.test.ts`
- Search/update comments in: `daemon/src/index.ts`, `client/src/voice/drivingReducer.ts`, `client/src/voice/drivingLoop.ts`, `client/src/screens/Driving.tsx`, `client/src/voice/audioSource.ts`

**Step 1: Write failing tests/checks**

Run a search-based check manually and/or add a small test if appropriate:

```bash
rg -n "xAI STT|XaiSttSession|api.x.ai/v1/stt|grok-stt|transcript\.partial.*xAI" daemon/src client/src test
```

Expected before cleanup: finds obsolete xAI STT references.

**Step 2: Implement minimal cleanup**

- If no code imports `sttSession.ts`, delete it and its tests.
- If helper functions are still useful, rename/move them so they are not xAI-specific.
- Update comments that claim xAI streaming powers live transcript.
- Keep xAI references that are genuinely about chat/TTS or provider configuration outside STT.

**Step 3: Verify**

```bash
rg -n "XaiSttSession|api.x.ai/v1/stt|xAI STT" daemon/src client/src test || true
npm test -- test/sttDaemon.test.ts test/drivingReducer.test.ts test/drivingLoop.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add daemon/src client/src test
git commit -m "chore: remove legacy xAI streaming STT path"
```

---

## Task 6: Optional near-live chunk transcript foundation (only after full-turn switch works)

**Files:**
- Create: `daemon/src/phraseChunker.ts`
- Create: `daemon/src/vad.ts` only if package smoke passes without native build
- Modify: `daemon/src/inferSttSession.ts`
- Test: `test/phraseChunker.test.ts`, `test/inferSttSession.test.ts`

**Important:** This task is optional for the first working branch. Do not start it until Tasks 1-5 are green and reviewed. If David wants the smallest branch, skip this task and ship full-turn infer first.

**Step 1: Dependency smoke before adding package**

A Codex subagent must test in the worktree:

```bash
npm view @echogarden/fvad-wasm version description --json
npm install @echogarden/fvad-wasm --package-lock-only
npm test -- test/openclawInfer.test.ts
```

Confirm package install does not invoke native build tooling. If it does, stop and report.

**Step 2: Write failing chunker tests**

Test pure chunker logic with mocked `isSpeech` booleans:

1. one-frame spike does not start a chunk;
2. sustained speech starts after hysteresis;
3. short pause under threshold does not split;
4. 700ms+ silence ends chunk;
5. pre-roll and post-roll are included;
6. max chunk forces a safe cut only after silence when possible.

Run:

```bash
npm test -- test/phraseChunker.test.ts
```

**Step 3: Implement minimal chunker and integrate**

- Use VAD/boolean source only for chunk boundaries.
- Emit committed chunk transcripts through `onPartial(text, true)` when chunk infer completes.
- Keep the final full-turn infer as authoritative `onDone`.
- Queue chunk transcriptions; do not run unlimited concurrent infer processes.

**Step 4: Verify**

```bash
npm test -- test/phraseChunker.test.ts test/inferSttSession.test.ts
npm run typecheck
```

**Step 5: Commit**

```bash
git add package.json package-lock.json daemon/src test
git commit -m "feat: add VAD-delimited infer transcript chunks"
```

---

## Final verification after all selected tasks

Supervisor, not implementer, must run:

```bash
npm test
npm run typecheck
rm -f /tmp/clawkie-openclaw-infer-smoke.mp3
openclaw infer tts convert --text "clawkie infer transcription smoke test" --output /tmp/clawkie-openclaw-infer-smoke.mp3 --json
openclaw infer audio transcribe --file /tmp/clawkie-openclaw-infer-smoke.mp3 --json
```

If a local Clawkie page smoke is practical without starting/killing Node servers, verify the browser control flow. Do not start or kill Node servers unless David explicitly asks.

## Open decision for David

Choose implementation scope before the first task starts:

- **Scope A — smallest safe switch:** Tasks 1-5 only. Replaces xAI streaming STT with final full-turn `openclaw infer` transcription. Live captions become final-only unless the UI already handles no partials gracefully.
- **Scope B — near-live infer branch:** Tasks 1-6. Adds VAD/WASM chunking so Clawkie can show committed phrase transcripts before final stop, while still using full-turn infer as authority.

Recommendation: start with **Scope A**, because it removes the failing xAI STT path and gives us a clean verified base. Then add Task 6 in the same branch only if final-only UX is not acceptable.
