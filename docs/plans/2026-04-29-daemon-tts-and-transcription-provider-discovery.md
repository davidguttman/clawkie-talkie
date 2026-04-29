# Daemon TTS and Transcription Provider Discovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the Clawkie Talkie daemon publish available OpenClaw providers for both speech output and transcription input, and let the client choose the TTS provider/model/voice plus the STT provider/model used for future turns.

**Architecture:** The daemon remains the only authority for OpenClaw provider discovery and auth state. The existing TTS catalog path stays, and we add a matching STT catalog path backed by `openclaw infer audio providers --json`; the client stores only provider/model/voice ids and sends the canonical settings over the existing WebRTC DataChannel. TTS synthesis continues to use per-request `openclaw infer tts convert --model <provider/model> --voice <voice>`, while transcription uses per-request `openclaw infer audio transcribe --model <provider/model>` without mutating global OpenClaw preferences.

**Tech Stack:** TypeScript, React, WebRTC DataChannel protocol, Node 24, Vitest, OpenClaw CLI `openclaw infer tts providers --json`, OpenClaw CLI `openclaw infer audio providers --json`, OpenClaw CLI `openclaw infer audio transcribe --model <provider/model>`.

---

## Current correction

The already-merged provider discovery work on `master` only covers TTS/output:

- `tts.catalog.request`
- `tts.catalog`
- `settings.tts`
- Settings UI provider/model/voice controls for speech output

That is incomplete. Clawkie Talkie has two provider-choice surfaces:

1. **Transcription input / STT** — microphone audio to text via `openclaw infer audio transcribe`.
2. **Speech output / TTS** — assistant reply text to audio via `openclaw infer tts convert`.

Both need daemon-side provider discovery and client-side selection. Do not treat “voice provider” as synonymous with TTS only.

## Non-negotiable execution process

1. Use TDD for each task: failing focused test first, minimal implementation, focused verification, commit.
2. Keep the phone and daemon protocol copies mirrored: update `client/src/voice/protocol.ts`, `daemon/src/protocol.ts`, and `test/protocol.test.ts` together.
3. Do **not** call global provider mutation commands from Clawkie Talkie. Selection must be per-request via `--model <provider/model>` when possible.
4. Do not expose provider credentials to the browser. The phone only stores provider/model/voice ids; all discovery and inference stay daemon-side.
5. Preserve backward compatibility with existing `{ settings: { voice, tts } }` messages and existing localStorage records.
6. Treat TTS and STT as separate selections. A user choosing OpenAI for TTS must still be able to choose xAI, Google, Groq, etc. for transcription.

## Branch and worktree

Because Clawkie Talkie is released/shared, implementation should happen in a worktree.

- Branch: `feature/daemon-stt-provider-discovery`
- Worktree: `/mnt/data/play/web/clawkie-talkie/.worktrees/daemon-stt-provider-discovery`
- Project root: `/mnt/data/play/web/clawkie-talkie`

## Current relevant files

- `client/src/voice/protocol.ts`
  - Currently has TTS catalog types/messages only.
  - Add mirrored STT catalog and selection types/messages.
- `daemon/src/protocol.ts`
  - Mirror client protocol changes exactly.
- `test/protocol.test.ts`
  - Pin new STT protocol factories and mirrored shapes.
- `daemon/src/openclawInfer.ts`
  - Already builds/parses TTS provider catalog and accepts transcription `model` option.
  - Add audio-provider command, parser, and catalog loader.
- `daemon/src/inferSttSession.ts`
  - Already calls OpenClaw transcription.
  - Must receive and pass through optional STT model override.
- `daemon/src/voiceSession.ts`
  - Currently stores `ttsSelection` and serves TTS catalog requests.
  - Add `sttSelection`, serve STT catalog requests, and pass selected STT model into `OpenClawInferSttSession`.
- `daemon/src/ttsCatalog.ts`
  - Existing TTS cache pattern; add parallel STT cache or a generic provider-catalog cache.
- `client/src/storage.ts`
  - Currently persists `settings.tts` only.
  - Add `settings.stt` migration/normalization.
- `client/src/rtc/RtcContext.tsx`
  - Currently stores/requests only `ttsCatalog` and dedupes settings on TTS fields.
  - Add STT catalog state/request and include STT fields in settings dedupe.
- `client/src/screens/Settings.tsx`
  - Currently has one VOICE section for TTS.
  - Split into “Transcription” and “Voice” controls or otherwise clearly present both provider selectors.
- `test/openclawInfer.test.ts`
  - Add STT provider parser/runner tests.
- `test/voiceSession.test.ts`
  - Add STT catalog request and selected-model application tests.
- `test/rtcTtsCatalog.test.ts`
  - Rename or extend to include both provider catalogs.
- `test/settingsStorage.test.ts`
  - Add STT persistence tests.
- `test/settingsScreen.test.ts`
  - Add STT provider UI tests.

## Desired runtime behavior

- When the phone connects to the per-session voice room, it requests both catalogs:
  - `tts.catalog.request`
  - `stt.catalog.request`
- The daemon returns both catalogs independently:
  - `tts.catalog`
  - `stt.catalog`
- The client stores selections like:

```ts
export interface TtsSelection {
  providerId?: string;
  model?: string;
  voice?: string;
}

export interface SttSelection {
  providerId?: string;
  model?: string;
}

export interface VoiceSettings {
  voice?: string; // legacy TTS alias only
  tts?: TtsSelection;
  stt?: SttSelection;
}
```

- Settings update messages include both selections when present:

```json
{
  "t": "settings.update",
  "settings": {
    "tts": { "providerId": "openai", "model": "gpt-4o-mini-tts", "voice": "nova" },
    "stt": { "providerId": "xai", "model": "grok-stt" },
    "voice": "nova"
  }
}
```

- TTS command behavior stays:
  - pass `--model <provider>/<model>` only when both provider and model are non-empty;
  - pass `--voice <voice>` only when the selected voice is non-empty and a model override is present;
  - never call global provider mutation.
- STT command behavior becomes:
  - pass `--model <provider>/<model>` to `openclaw infer audio transcribe` only when both provider and model are non-empty;
  - preserve `--language <code>`;
  - never call global provider mutation;
  - if selected STT provider/model is invalid for the latest catalog, fall back to OpenClaw defaults and emit a stable warning log, not a user-facing failure.

## Observed OpenClaw audio provider shape

As of 2026-04-29, `openclaw infer audio providers --json` returns a bare array, not the TTS envelope shape:

```json
[
  {
    "available": true,
    "configured": true,
    "selected": false,
    "id": "xai",
    "capabilities": ["audio"],
    "defaultModels": { "audio": "grok-stt" }
  }
]
```

Normalize this into an STT catalog:

```ts
export interface SttCatalogProvider {
  id: string;
  name: string;
  configured: boolean;
  selected: boolean;
  available: boolean;
  models: string[];
}

export interface SttCatalog {
  activeProvider?: string;
  generatedAt: string;
  providers: SttCatalogProvider[];
}
```

For now, `models` should include `defaultModels.audio` when present. If OpenClaw later exposes a richer audio model list, replace this parser behind the same catalog contract.

---

## Task 1: Protocol types for STT catalog and selection

**Files:**
- Modify: `client/src/voice/protocol.ts`
- Modify: `daemon/src/protocol.ts`
- Modify: `test/protocol.test.ts`

**Step 1: Write failing tests**

Add protocol tests for:

```ts
expect(phoneClient.sttCatalogRequest()).toEqual({ t: 'stt.catalog.request' });
expect(phoneDaemon.sttCatalogRequest()).toEqual({ t: 'stt.catalog.request' });

const stt = { providerId: 'xai', model: 'grok-stt' };
expect(phoneClient.settingsUpdate({ stt })).toEqual({
  t: 'settings.update',
  settings: { stt },
});

const catalog = {
  activeProvider: 'xai',
  generatedAt: '2026-04-29T00:00:00.000Z',
  providers: [{
    id: 'xai',
    name: 'xai',
    configured: true,
    selected: true,
    available: true,
    models: ['grok-stt'],
  }],
};
expect(daemonClient.sttCatalog(catalog)).toEqual({ t: 'stt.catalog', catalog });
```

Run:

```bash
npm test -- test/protocol.test.ts
```

Expected before implementation: FAIL because STT catalog factories/types do not exist.

**Step 2: Implement minimal protocol changes**

Add mirrored types:

```ts
export interface SttSelection {
  providerId?: string;
  model?: string;
}

export interface VoiceSettings {
  voice?: string;
  tts?: TtsSelection;
  stt?: SttSelection;
}
```

Add messages:

```ts
| { t: 'stt.catalog.request' }
| { t: 'stt.catalog'; catalog: SttCatalog }
```

**Step 3: Verify**

```bash
npm test -- test/protocol.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add client/src/voice/protocol.ts daemon/src/protocol.ts test/protocol.test.ts
git commit -m "feat: add STT catalog protocol"
```

---

## Task 2: Daemon OpenClaw STT catalog discovery helpers

**Files:**
- Modify: `daemon/src/openclawInfer.ts`
- Test: `test/openclawInfer.test.ts`

**Step 1: Write failing tests**

Add tests for:

1. `buildInferAudioProvidersCommand()` returns:

```ts
{ command: 'openclaw', args: ['infer', 'audio', 'providers', '--json'] }
```

2. `parseInferAudioProviders(stdout)` accepts the observed bare-array provider output and returns:

```ts
{
  activeProvider: 'xai',
  generatedAt: expect.any(String),
  providers: [{
    id: 'xai',
    name: 'xai',
    configured: true,
    selected: true,
    available: true,
    models: ['grok-stt'],
  }],
}
```

3. It filters providers without `audio` capability.
4. It tolerates missing `defaultModels.audio` with `models: []`.
5. It rejects invalid JSON and invalid provider records with clear errors.
6. `getSttCatalogWithOpenClawInfer({ exec })` calls the command and parses stdout.
7. `getSttCatalogWithOpenClawInfer` maps exec failures to `openclaw_infer_stt_catalog_failed`.

Run:

```bash
npm test -- test/openclawInfer.test.ts
```

Expected before implementation: FAIL because functions do not exist.

**Step 2: Implement minimal code**

Add:

```ts
export function buildInferAudioProvidersCommand(): InferAudioProvidersCommand
export function parseInferAudioProviders(stdout: string): SttCatalog
export async function getSttCatalogWithOpenClawInfer(opts?): Promise<SttCatalog>
```

Use `defaultModels.audio` as the one selectable model for now.

**Step 3: Verify**

```bash
npm test -- test/openclawInfer.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add daemon/src/openclawInfer.ts test/openclawInfer.test.ts
git commit -m "feat: discover OpenClaw STT providers"
```

---

## Task 3: STT catalog cache and VoiceSession serving

**Files:**
- Modify or create: `daemon/src/sttCatalog.ts`
- Modify: `daemon/src/voiceSession.ts`
- Test: `test/voiceSession.test.ts`

**Step 1: Write failing tests**

Add tests that prove:

1. `VoiceSession` handles `{ t: 'stt.catalog.request' }` by sending `{ t: 'stt.catalog', catalog }` from an injected `sttCatalogProvider`.
2. If provider loading fails, the daemon sends an empty stable STT catalog, not an unhandled error.
3. TTS catalog behavior remains unchanged.

Run:

```bash
npm test -- test/voiceSession.test.ts
```

Expected before implementation: FAIL because `stt.catalog.request` is ignored.

**Step 2: Implement minimal code**

- Add `createEmptySttCatalog()`.
- Add `defaultSttCatalogCache` parallel to `defaultTtsCatalogCache`, or extract a tiny generic TTL cache if that keeps code smaller.
- Add `sttCatalogProvider?: () => Promise<SttCatalog>` to `VoiceSessionRuntimeOptions`.
- Handle `msg.t === 'stt.catalog.request'` in `handleControl()`.
- Send `daemonToPhone.sttCatalog(catalog)`.

**Step 3: Verify**

```bash
npm test -- test/voiceSession.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add daemon/src/sttCatalog.ts daemon/src/voiceSession.ts test/voiceSession.test.ts
git commit -m "feat: serve STT provider catalog"
```

---

## Task 4: Persist STT selection in client settings

**Files:**
- Modify: `client/src/storage.ts`
- Test: `test/settingsStorage.test.ts`

**Step 1: Write failing tests**

Add tests proving:

1. Empty settings default to `stt: {}`.
2. Stored `stt.providerId` / `stt.model` are loaded and trimmed.
3. Empty or non-string STT fields are dropped.
4. Existing records with only TTS/voice still load unchanged.
5. `saveSettings()` preserves `stt` while continuing to normalize TTS legacy voice mirror.

Run:

```bash
npm test -- test/settingsStorage.test.ts
```

Expected before implementation: FAIL because settings do not include `stt`.

**Step 2: Implement minimal code**

- Add `SttSelection` type from protocol.
- Add `stt: SttSelection` to `Settings` and `DEFAULT_SETTINGS`.
- Add `normalizeSttSelection()`.
- Preserve existing TTS/legacy behavior.

**Step 3: Verify**

```bash
npm test -- test/settingsStorage.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add client/src/storage.ts test/settingsStorage.test.ts
git commit -m "feat: persist STT provider selection"
```

---

## Task 5: Send STT selection over RTC and request both catalogs

**Files:**
- Modify: `client/src/rtc/RtcContext.tsx`
- Modify or rename: `test/rtcTtsCatalog.test.ts`

**Step 1: Write failing tests**

Add tests proving:

1. Once the voice room is open, the client sends both `tts.catalog.request` and `stt.catalog.request` once per room.
2. Manual `requestSttCatalog()` is guarded the same way as `requestTtsCatalog()`:
   - no rendezvous room send;
   - no pre-open send;
   - sends only in open voice room.
3. Inbound `stt.catalog` updates React context state.
4. Initial `rendezvous.join` includes `settings.stt` when present.
5. Later `settings.update` emits when `settings.stt.providerId` or `settings.stt.model` changes, even if TTS is unchanged.
6. Dedupe key includes both TTS and STT selections.

Run:

```bash
npm test -- test/rtcTtsCatalog.test.ts
```

Expected before implementation: FAIL because STT catalog state/request does not exist and dedupe ignores STT.

**Step 2: Implement minimal code**

- Add `sttCatalog` and `requestSttCatalog()` to `RtcContextValue`.
- Handle inbound `stt.catalog`.
- Request both catalogs once per voice room.
- Include `settings.stt` in normalized voice/settings payload and dedupe key.

**Step 3: Verify**

```bash
npm test -- test/rtcTtsCatalog.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add client/src/rtc/RtcContext.tsx test/rtcTtsCatalog.test.ts
git commit -m "feat: sync STT provider catalog to client"
```

---

## Task 6: Apply selected STT model to transcription turns

**Files:**
- Modify: `daemon/src/voiceSession.ts`
- Modify: `daemon/src/inferSttSession.ts` if needed
- Test: `test/voiceSession.test.ts`
- Test: `test/inferSttSession.test.ts` if needed

**Step 1: Write failing tests**

Add tests proving:

1. `VoiceSession` stores `settings.stt` from initial `voiceSettings`.
2. `settings.update` changes the STT selection for the next turn.
3. `openStt()` passes `model: '<provider>/<model>'` into `OpenClawInferSttSessionOptions` when both fields are selected.
4. If either provider or model is missing, no model override is passed.
5. Existing `sttLanguage` still passes through.
6. TTS selection still affects only TTS and not STT.

Run:

```bash
npm test -- test/voiceSession.test.ts test/inferSttSession.test.ts
```

Expected before implementation: FAIL because `VoiceSession` has only `ttsSelection`.

**Step 2: Implement minimal code**

- Add `private sttSelection: SttSelection = {}`.
- Add `normalizeSttSelection(settings)` and `sttModelOverride(selection)` helpers.
- Update `applyVoiceSettings()` to apply both TTS and STT.
- Pass `model` into `OpenClawInferSttSessionOptions`.
- Ensure `OpenClawInferSttSession` passes `model` into `transcribeWithOpenClawInfer()` if it does not already.

**Step 3: Verify**

```bash
npm test -- test/voiceSession.test.ts test/inferSttSession.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add daemon/src/voiceSession.ts daemon/src/inferSttSession.ts test/voiceSession.test.ts test/inferSttSession.test.ts
git commit -m "feat: apply selected STT provider per turn"
```

---

## Task 7: Settings UI for both transcription and voice providers

**Files:**
- Modify: `client/src/app.tsx`
- Modify: `client/src/screens/Settings.tsx`
- Test: `test/settingsScreen.test.ts`

**Step 1: Write failing tests**

Add tests for pure helpers and component behavior:

1. `configuredSttProviders(catalog)` sorts configured/available providers first.
2. STT providers with no model are disabled and labeled `(no model)` or equivalent.
3. Selecting an STT provider writes `settings.stt.providerId` and its preferred/default model.
4. Selecting an STT model updates only `settings.stt.model` and preserves TTS selection.
5. Selecting a TTS provider/voice still updates only `settings.tts` and legacy `settings.voice`.
6. No-catalog fallback shows separate status text for transcription and voice catalogs.

Run:

```bash
npm test -- test/settingsScreen.test.ts
```

Expected before implementation: FAIL because Settings has only TTS provider controls.

**Step 2: Implement minimal UI**

- Pass `sttCatalog` and `requestSttCatalog` from `useRtc()` through `App` to Settings.
- Split settings into clear sections:
  - `TRANSCRIPTION` with provider/model selectors.
  - `VOICE` with provider/model/voice selectors and speed.
- Keep controls compact; use existing `SelectRow` / `StatusRow` patterns.
- Do not show credentials or auth prompts beyond configured/unavailable state.

**Step 3: Verify**

```bash
npm test -- test/settingsScreen.test.ts test/settingsStorage.test.ts test/rtcTtsCatalog.test.ts
npm run typecheck
npm run build
```

**Step 4: Commit**

```bash
git add client/src/app.tsx client/src/screens/Settings.tsx test/settingsScreen.test.ts
git commit -m "feat: choose transcription provider in settings"
```

---

## Task 8: Docs, smoke checks, and final verification

**Files:**
- Modify: `daemon/README.md`
- Modify: `docs/install-daemon.md`
- Modify: `docs/voice-handoff.md`
- Optional modify: `docs/plans/2026-04-29-daemon-voice-provider-discovery.md` with a note pointing to this follow-up plan.

**Step 1: Update docs**

Document:

- TTS discovery:
  - `openclaw infer tts providers --json`
  - per-request `openclaw infer tts convert --model <provider/model> --voice <voice>`
- STT discovery:
  - `openclaw infer audio providers --json`
  - per-request `openclaw infer audio transcribe --file <wav> --json --model <provider/model>`
- Phone storage:
  - only provider/model/voice ids, no credentials.
- DataChannel messages:
  - `tts.catalog.request` / `tts.catalog`
  - `stt.catalog.request` / `stt.catalog`
  - `settings.update` with `tts` and `stt`.
- Explicitly state Clawkie Talkie must not mutate global OpenClaw provider preferences.

**Step 2: Smoke check CLI support**

Run:

```bash
openclaw infer tts providers --json
openclaw infer audio providers --json
```

Then run one small transcription smoke using a tiny fixture WAV already in the test tree or generated by a test helper:

```bash
openclaw infer audio transcribe --file <fixture.wav> --json --model <configured-provider>/<model>
```

Do not require a specific provider in docs; choose one configured provider from the local catalog during verification.

**Step 3: Final verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

**Step 4: Commit**

```bash
git add daemon/README.md docs/install-daemon.md docs/voice-handoff.md docs/plans/2026-04-29-daemon-voice-provider-discovery.md
git commit -m "docs: cover TTS and STT provider selection"
```

---

## Final review checklist

- [ ] Protocol copies remain mirrored.
- [ ] Client stores only provider/model/voice ids.
- [ ] Browser never receives provider credentials.
- [ ] TTS selection and STT selection are independent.
- [ ] TTS uses per-request `--model` / `--voice`.
- [ ] STT uses per-request `--model`.
- [ ] No global OpenClaw provider mutation commands are called.
- [ ] Provider-less/model-less entries are visible only as disabled or unavailable state.
- [ ] Old localStorage records still load.
- [ ] Existing legacy `settings.voice` path still works for TTS.
- [ ] Full test/typecheck/build gates pass.
