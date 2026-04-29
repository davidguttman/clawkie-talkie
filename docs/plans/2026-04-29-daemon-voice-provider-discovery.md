# Daemon Voice Provider Discovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the Clawkie Talkie daemon publish available OpenClaw TTS providers/voices to the phone client, and let the client choose the provider/model/voice used for future replies.

**Architecture:** The daemon remains the source of truth because it is the only side that can safely inspect OpenClaw provider configuration. It discovers TTS provider metadata through `openclaw infer tts providers --json`, sends a normalized catalog over the existing WebRTC DataChannel, and applies the selected voice/provider/model to each daemon-side OpenClaw infer TTS command without mutating global OpenClaw TTS preferences. The client replaces its hardcoded voice list with catalog-backed settings while preserving localStorage migration and a safe fallback for disconnected/cold-start states.

**Tech Stack:** TypeScript, React, WebRTC DataChannel protocol, Node 24, Vitest, OpenClaw CLI `openclaw infer tts providers --json`, OpenClaw CLI `openclaw infer tts convert --model <provider/model> --voice <id>`.

---

## Non-negotiable execution process

1. Use TDD for each task: failing focused test first, minimal implementation, focused verification, commit.
2. Keep the phone and daemon protocol copies mirrored: update `client/src/voice/protocol.ts`, `daemon/src/protocol.ts`, and `test/protocol.test.ts` together.
3. Do **not** call `openclaw infer tts set-provider` from Clawkie Talkie. Provider choice must be per-request via `--model <provider/model>` when possible, never global mutable OpenClaw state.
4. Do not reintroduce provider credentials into the browser. The phone only stores provider/model/voice ids; all discovery and synthesis stay daemon-side.
5. Preserve backward compatibility with existing `{ settings: { voice } }` messages and existing localStorage records.

## Current relevant files

- `daemon/src/openclawInfer.ts`
  - Currently has hardcoded OpenAI voice allowlist and `buildInferTtsCommand({ voice, model })`.
  - Already supports `--model <provider/model>` in the command builder.
- `daemon/src/ttsSession.ts`
  - Passes `voice` to `synthesizeTtsWithOpenClawInfer`.
  - Needs to pass optional model override too.
- `daemon/src/voiceSession.ts`
  - Holds `ttsVoice`, applies `settings.update`, and creates `OpenClawInferTtsSession` with `{ text, voice }`.
  - Good home for applying runtime TTS selection and serving catalog requests.
- `daemon/src/peer.ts`
  - Reads initial rendezvous `settings.voice` and passes it into `VoiceSession`.
- `daemon/src/protocol.ts` and `client/src/voice/protocol.ts`
  - Mirrored wire protocol.
- `client/src/storage.ts`
  - Current static `VOICE_IDS = ['eve','ara','rex','sal','leo']` is stale for OpenClaw infer defaults.
  - Needs migration to a dynamic TTS selection shape.
- `client/src/screens/Settings.tsx`
  - Current UI renders hardcoded voice segmented buttons.
  - Needs catalog-backed provider/model/voice controls.
- `client/src/rtc/RtcContext.tsx`
  - Sends initial voice settings and subsequent `settings.update`.
  - Good place to request/store daemon TTS catalog.

## Desired runtime behavior

- When the phone connects to the per-session voice room, it requests the daemon TTS catalog.
- The daemon returns a normalized catalog shaped like:

```ts
export interface TtsCatalog {
  activeProvider?: string;
  providers: TtsProviderOption[];
  generatedAt: string;
}

export interface TtsProviderOption {
  id: string;
  name: string;
  configured: boolean;
  selected: boolean;
  available: boolean;
  models: string[];
  voices: TtsVoiceOption[];
}

export interface TtsVoiceOption {
  id: string;
  name: string;
}
```

- The client shows only usable provider options by default:
  - `configured && available` providers first;
  - unconfigured providers may be shown disabled or hidden behind a small unavailable state;
  - a provider with voices but no models can still show voices, but the implementation must not pretend it can per-request switch unless OpenClaw exposes a model override for it.
- The client persists a local setting shaped like:

```ts
export interface TtsSelection {
  providerId?: string;
  model?: string;
  voice?: string;
}

export interface Settings extends ExportSettings {
  tts: TtsSelection;
  // legacy compatibility only during migration:
  voice?: string;
  speed: number;
}
```

- Initial rendezvous and later settings updates send the full TTS selection:

```json
{
  "t": "settings.update",
  "settings": {
    "tts": { "providerId": "openai", "model": "gpt-4o-mini-tts", "voice": "nova" },
    "voice": "nova"
  }
}
```

- Daemon TTS command behavior:
  - pass `--voice <voice>` when the selected voice is non-empty;
  - pass `--model <provider>/<model>` only when both provider and model are non-empty;
  - never mutate global OpenClaw provider selection;
  - if selected provider/model is invalid for the latest catalog, fall back to provider defaults and emit a stable warning log, not a user-facing failure.

---

## Task 1: Protocol types for TTS catalog and selection

**Files:**
- Modify: `client/src/voice/protocol.ts`
- Modify: `daemon/src/protocol.ts`
- Modify: `test/protocol.test.ts`

**Step 1: Write failing tests**

Add protocol tests for:

```ts
expect(phoneClient.ttsCatalogRequest()).toEqual({ t: 'tts.catalog.request' });
expect(phoneDaemon.ttsCatalogRequest()).toEqual({ t: 'tts.catalog.request' });

const selection = { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' };
expect(phoneClient.settingsUpdate({ voice: 'nova', tts: selection })).toEqual({
  t: 'settings.update',
  settings: { voice: 'nova', tts: selection },
});

const catalog = {
  activeProvider: 'openai',
  generatedAt: '2026-04-29T00:00:00.000Z',
  providers: [{
    id: 'openai',
    name: 'OpenAI',
    configured: true,
    selected: true,
    available: true,
    models: ['gpt-4o-mini-tts'],
    voices: [{ id: 'nova', name: 'nova' }],
  }],
};
expect(daemonClient.ttsCatalog(catalog)).toEqual({ t: 'tts.catalog', catalog });
```

Run:

```bash
npm test -- test/protocol.test.ts
```

Expected before implementation: FAIL because the new message factories/types do not exist.

**Step 2: Implement minimal protocol changes**

Add mirrored interfaces in both protocol copies:

```ts
export interface TtsSelection {
  providerId?: string;
  model?: string;
  voice?: string;
}

export interface VoiceSettings {
  voice?: string;      // legacy alias, keep for compatibility
  tts?: TtsSelection;  // new canonical selection
}
```

Add messages:

```ts
| { t: 'tts.catalog.request' }
| { t: 'tts.catalog'; catalog: TtsCatalog }
```

Keep old voice-only messages valid.

**Step 3: Verify**

```bash
npm test -- test/protocol.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add client/src/voice/protocol.ts daemon/src/protocol.ts test/protocol.test.ts
git commit -m "feat: add TTS catalog protocol"
```

---

## Task 2: Daemon OpenClaw TTS catalog discovery helpers

**Files:**
- Modify: `daemon/src/openclawInfer.ts`
- Create: `test/ttsCatalog.test.ts`

**Step 1: Write failing tests**

Test pure helpers with injected fake exec:

1. `buildInferTtsProvidersCommand()` returns:

```ts
{ command: 'openclaw', args: ['infer', 'tts', 'providers', '--json'] }
```

2. `parseInferTtsProviders(stdout)` normalizes provider JSON from the real CLI shape:

```json
{
  "providers": [{
    "available": true,
    "configured": true,
    "selected": true,
    "id": "openai",
    "name": "OpenAI",
    "models": ["gpt-4o-mini-tts"],
    "voices": ["alloy", "nova"]
  }],
  "active": "openai"
}
```

Expected normalized voices:

```ts
[{ id: 'alloy', name: 'alloy' }, { id: 'nova', name: 'nova' }]
```

3. Parser also accepts voices already shaped as objects:

```ts
voices: [{ id: 'nova', name: 'Nova' }]
```

4. Invalid JSON, missing `providers`, or provider entries without ids throw clear parser errors.
5. `getTtsCatalogWithOpenClawInfer({ exec })` calls the providers command and returns the normalized catalog.
6. Exec failure throws an error with stable code/message containing `openclaw_infer_tts_catalog_failed`.

Run:

```bash
npm test -- test/ttsCatalog.test.ts
```

Expected before implementation: FAIL.

**Step 2: Implement minimal code**

In `daemon/src/openclawInfer.ts`, add:

```ts
export function buildInferTtsProvidersCommand(): InferCommand;
export function parseInferTtsProviders(stdout: string): TtsCatalog;
export async function getTtsCatalogWithOpenClawInfer(opts?: { exec?: OpenClawInferExec; signal?: AbortSignal }): Promise<TtsCatalog>;
```

Keep command execution injectable like existing STT/TTS helpers.

**Step 3: Verify**

```bash
npm test -- test/ttsCatalog.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add daemon/src/openclawInfer.ts test/ttsCatalog.test.ts
git commit -m "feat: discover OpenClaw TTS providers"
```

---

## Task 3: Cache and serve daemon TTS catalog over the voice lane

**Files:**
- Create: `daemon/src/ttsCatalog.ts`
- Modify: `daemon/src/voiceSession.ts`
- Modify: `test/voiceSession.test.ts`
- Test: `test/ttsCatalog.test.ts`

**Step 1: Write failing tests**

Add `daemon/src/ttsCatalog.ts` tests:

1. `createTtsCatalogCache({ loadCatalog, ttlMs })` calls `loadCatalog` once for repeated reads within TTL.
2. After TTL, it refreshes.
3. If refresh fails but a previous catalog exists, it returns the previous catalog.
4. If initial load fails, it returns a safe empty catalog:

```ts
{
  activeProvider: undefined,
  generatedAt: expect.any(String),
  providers: [],
}
```

Add `test/voiceSession.test.ts` coverage:

1. When the phone sends `{ t: 'tts.catalog.request' }`, daemon sends `{ t: 'tts.catalog', catalog }`.
2. Unknown catalog load failures do not close the session and still send an empty catalog.

Run:

```bash
npm test -- test/ttsCatalog.test.ts test/voiceSession.test.ts
```

Expected before implementation: FAIL.

**Step 2: Implement minimal code**

- Add a TTL cache module. Suggested TTL: 60 seconds.
- Add optional dependency injection to `VoiceSessionRuntimeOptions`:

```ts
ttsCatalogProvider?: () => Promise<TtsCatalog>;
```

- In `VoiceSession.handleControlMessage`, handle:

```ts
if (msg.t === 'tts.catalog.request') {
  void this.sendTtsCatalog();
  return;
}
```

- Implement `sendTtsCatalog()` as async best-effort:
  - await injected/catalog cache;
  - send `daemonToPhone.ttsCatalog(catalog)`;
  - on error send empty catalog.

**Step 3: Verify**

```bash
npm test -- test/ttsCatalog.test.ts test/voiceSession.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add daemon/src/ttsCatalog.ts daemon/src/voiceSession.ts test/ttsCatalog.test.ts test/voiceSession.test.ts
git commit -m "feat: serve TTS catalog from daemon"
```

---

## Task 4: Apply provider/model/voice selection to TTS synthesis

**Files:**
- Modify: `daemon/src/openclawInfer.ts`
- Modify: `daemon/src/ttsSession.ts`
- Modify: `daemon/src/voiceSession.ts`
- Modify: `daemon/src/peer.ts`
- Modify: `test/ttsVoice.test.ts`
- Modify: `test/inferTtsSession.test.ts`
- Modify: `test/voiceSession.test.ts`

**Step 1: Write failing tests**

Add/adjust tests for:

1. `buildInferTtsCommand({ text, outputPath, voice: 'nova', model: 'openai/gpt-4o-mini-tts' })` includes:

```ts
'--model', 'openai/gpt-4o-mini-tts', '--voice', 'nova'
```

2. It no longer drops non-OpenAI voices in the command builder. The daemon should trust catalog validation and let OpenClaw/provider decide voice support:

```ts
buildInferTtsCommand({ text: 'hello', outputPath: '/tmp/a.mp3', voice: 'eve', model: 'xai/some-model' })
```

includes `--voice eve`.

3. `OpenClawInferTtsSession` forwards both `voice` and `model` to `synthesize`.
4. `VoiceSession.applyVoiceSettings({ tts: { providerId, model, voice } })` stores the full selection.
5. On the next reply, `VoiceSession` creates TTS session with:

```ts
{ text: 'spoken reply', voice: 'nova', model: 'openai/gpt-4o-mini-tts' }
```

6. Legacy settings still work:

```ts
applyVoiceSettings({ voice: 'rex' })
```

sets only `voice` and leaves model undefined.

Run:

```bash
npm test -- test/ttsVoice.test.ts test/inferTtsSession.test.ts test/voiceSession.test.ts
```

Expected before implementation: FAIL for model forwarding/full selection.

**Step 2: Implement minimal code**

- Replace `ttsVoice` field with:

```ts
private ttsSelection: TtsSelection = {};
```

- Normalize settings in one helper:

```ts
function normalizeTtsSelection(settings: VoiceSettings | undefined): TtsSelection {
  const tts = settings?.tts ?? {};
  const voice = tts.voice?.trim() || settings?.voice?.trim() || undefined;
  const providerId = tts.providerId?.trim() || undefined;
  const model = tts.model?.trim() || undefined;
  return { ...(providerId ? { providerId } : {}), ...(model ? { model } : {}), ...(voice ? { voice } : {}) };
}
```

- Convert selection to OpenClaw model override only when both pieces exist:

```ts
function ttsModelOverride(selection: TtsSelection): string | undefined {
  return selection.providerId && selection.model
    ? `${selection.providerId}/${selection.model}`
    : undefined;
}
```

- Pass `{ text, voice: selection.voice, model: ttsModelOverride(selection) }` into `OpenClawInferTtsSession`.
- Thread initial rendezvous settings through `peer.ts` into `VoiceSession`.

**Step 3: Verify**

```bash
npm test -- test/ttsVoice.test.ts test/inferTtsSession.test.ts test/voiceSession.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add daemon/src/openclawInfer.ts daemon/src/ttsSession.ts daemon/src/voiceSession.ts daemon/src/peer.ts test/ttsVoice.test.ts test/inferTtsSession.test.ts test/voiceSession.test.ts
git commit -m "feat: apply selected TTS provider and voice"
```

---

## Task 5: Client settings storage migration for dynamic TTS selection

**Files:**
- Modify: `client/src/storage.ts`
- Modify: `test/settingsStorage.test.ts`

**Step 1: Write failing tests**

Add tests for:

1. Empty storage defaults to:

```ts
settings.tts.voice === undefined
settings.tts.providerId === undefined
settings.tts.model === undefined
```

or, if a default is chosen, document it clearly and keep it catalog-compatible.

2. Legacy `{ voice: 'rex' }` migrates to:

```ts
settings.tts.voice === 'rex'
```

3. New `{ tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' } }` persists intact.
4. Garbage provider/model/voice values normalize to trimmed strings or are dropped if empty.
5. `saveSettings()` writes the new shape and does not reintroduce stale `VOICE_IDS` validation.

Run:

```bash
npm test -- test/settingsStorage.test.ts
```

Expected before implementation: FAIL.

**Step 2: Implement minimal code**

- Remove hardcoded `VOICE_IDS` / `VOICE_LABELS` as the source of truth.
- Export `TtsSelection` from storage or import the shared protocol type if appropriate.
- Keep `settings.voice` only if needed temporarily for callers; prefer `settings.tts.voice` everywhere new.
- Update `DEFAULT_SETTINGS`.
- Keep export settings behavior unchanged.

**Step 3: Verify**

```bash
npm test -- test/settingsStorage.test.ts
npm run typecheck
```

**Step 4: Commit**

```bash
git add client/src/storage.ts test/settingsStorage.test.ts
git commit -m "feat: persist dynamic TTS selection"
```

---

## Task 6: Client RtcContext catalog state and settings updates

**Files:**
- Modify: `client/src/rtc/RtcContext.tsx`
- Create or modify: `test/rtcTtsCatalog.test.tsx` if React test harness exists; otherwise add focused tests to the nearest existing RTC/context test.
- Modify: `test/protocol.test.ts` only if a protocol edge was missed.

**Step 1: Write failing tests**

Test via fake `RtcClient` if the existing test harness supports it:

1. After the voice room DataChannel opens, `RtcProvider` sends `{ t: 'tts.catalog.request' }` once.
2. When receiving `{ t: 'tts.catalog', catalog }`, context exposes `ttsCatalog` to consumers.
3. Changing `settings.tts` sends `settings.update` with the full selection.
4. Dedupe compares provider/model/voice, not just voice.
5. Returning to the rendezvous room resets dedupe so the next voice room sends current settings again.

Run focused tests:

```bash
npm test -- test/rtcTtsCatalog.test.tsx
```

If no TSX test harness exists, use the smallest existing RTC test pattern and document the chosen file in the commit.

**Step 2: Implement minimal code**

- Extend `RtcContextValue`:

```ts
ttsCatalog: TtsCatalog | null;
requestTtsCatalog: () => void;
```

- Request catalog once after `activeRoomId !== hostPeerId && status === 'open'`.
- Listen for `msg.t === 'tts.catalog'` and store it in state.
- Change voice settings prop to pass `settings.tts` plus legacy `voice` alias if needed:

```tsx
voiceSettings={{ tts: settings.tts, voice: settings.tts.voice }}
```

- Dedupe serialized stable selection:

```ts
const key = JSON.stringify({
  providerId: voiceSettings?.tts?.providerId ?? '',
  model: voiceSettings?.tts?.model ?? '',
  voice: voiceSettings?.tts?.voice ?? voiceSettings?.voice ?? '',
});
```

**Step 3: Verify**

```bash
npm test -- test/rtcTtsCatalog.test.tsx
npm run typecheck
```

**Step 4: Commit**

```bash
git add client/src/rtc/RtcContext.tsx test/rtcTtsCatalog.test.tsx
git commit -m "feat: sync TTS catalog to client"
```

---

## Task 7: Settings UI for provider/model/voice selection

**Files:**
- Modify: `client/src/app.tsx`
- Modify: `client/src/screens/Settings.tsx`
- Modify: `test/settingsStorage.test.ts` only if UI exposes a new storage invariant.
- Add: `test/settingsScreen.test.tsx` if TSX component tests are already supported; otherwise add focused helper tests for option derivation.

**Step 1: Write failing tests**

Prefer pure helper tests if browser DOM test setup is thin. Extract helpers from `Settings.tsx` if useful:

```ts
export function configuredTtsProviders(catalog: TtsCatalog | null): TtsProviderOption[];
export function voicesForSelection(catalog: TtsCatalog | null, selection: TtsSelection): TtsVoiceOption[];
export function nextTtsSelectionAfterProviderChange(provider: TtsProviderOption): TtsSelection;
```

Test:

1. Configured/available providers sort before unconfigured/unavailable providers.
2. Selecting a provider chooses its selected/current/default model and first voice if current voice is invalid.
3. Selecting a voice preserves provider/model.
4. With no catalog, UI falls back to a disabled/loading state plus current saved voice label.
5. Unconfigured providers are not selectable.

Run:

```bash
npm test -- test/settingsScreen.test.tsx
```

or the helper test file chosen.

**Step 2: Implement minimal UI**

- In `App`, read `ttsCatalog` from `useRtc()` at the settings screen boundary. If hooks make that awkward inside `App`, wrap `SettingsScreen` props through a small child component.
- Update `SettingsScreen` props:

```ts
ttsCatalog: TtsCatalog | null;
onRefreshTtsCatalog?: () => void;
```

- Replace hardcoded segmented voice buttons with:
  - Provider segmented/select row.
  - Model row only when selected provider has more than one model.
  - Voice segmented/select row for selected provider voices.
  - Small status text: `Loaded from daemon` / `Connect to daemon to load voices` / `Provider unavailable`.
- Keep the compact layout usable on phone width; do not create a huge horizontal segmented row for 30 Google voices. Use a native `<select>` or vertical compact buttons for long lists.

**Step 3: Verify**

```bash
npm test -- test/settingsScreen.test.tsx test/settingsStorage.test.ts
npm run typecheck
npm run build
```

**Step 4: Commit**

```bash
git add client/src/app.tsx client/src/screens/Settings.tsx test/settingsScreen.test.tsx test/settingsStorage.test.ts
git commit -m "feat: choose daemon TTS provider in settings"
```

---

## Task 8: Documentation and manual verification

**Files:**
- Modify: `daemon/README.md`
- Modify: `docs/install-daemon.md`
- Modify: `docs/voice-handoff.md` if it documents settings behavior.

**Step 1: Update docs**

Document:

- Daemon discovers TTS provider/voice catalog via `openclaw infer tts providers --json`.
- Phone stores only provider/model/voice ids.
- Provider selection is per-request and does not call `openclaw infer tts set-provider`.
- If a provider cannot be selected per-request because it exposes no model id, the UI should either hide or disable it rather than mutating global state.

**Step 2: Verify full suite**

Run:

```bash
npm test
npm run typecheck
npm run build
```

**Step 3: Runtime smoke without starting a Node server manually**

Use jump.sh-managed/local dev flow only if a runtime UI smoke is needed. Do not run a raw Node server outside the existing project scripts/policy.

Minimum manual smoke:

```bash
openclaw infer tts providers --json
openclaw infer tts convert --text "catalog smoke" --output /tmp/clawkie-tts-smoke.mp3 --json --local --model openai/gpt-4o-mini-tts --voice nova
```

Expected:

- providers JSON includes at least one configured provider;
- convert returns JSON with an output path;
- no `set-provider` mutation is required.

**Step 4: Commit**

```bash
git add daemon/README.md docs/install-daemon.md docs/voice-handoff.md
git commit -m "docs: document daemon TTS catalog selection"
```

---

## Final acceptance checklist

- `npm test` passes.
- `npm run typecheck` passes.
- `npm run build` passes.
- Existing legacy saved voice settings migrate instead of resetting silently.
- Client can display the daemon-provided OpenClaw voice list, including current active OpenAI voices like `alloy`, `ash`, `nova`, etc.
- Client can select provider/model/voice and the next TTS turn passes the expected `--model provider/model` and `--voice id` to OpenClaw infer.
- No browser-visible credentials.
- No call to `openclaw infer tts set-provider` from daemon/client code.
- No global OpenClaw TTS preference mutation.

## Execution handoff

Plan complete and saved to `docs/plans/2026-04-29-daemon-voice-provider-discovery.md`.

Two execution options:

1. **Subagent-Driven (this session)** - dispatch fresh subagent per task, review between tasks, fast iteration.
2. **Parallel Session (separate)** - open a new session with executing-plans, batch execution with checkpoints.

Which approach?
