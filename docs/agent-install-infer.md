# Clawkie Talkie Agent Install — OpenClaw Infer

Clawkie Talkie uses the installed `openclaw` CLI for speech-to-text and text-to-speech:

- STT: `openclaw infer audio transcribe --file <wav> --json`
- TTS: `openclaw infer tts convert --text <text> --output <file> --json`

Before daemon verification, make sure the user's durable OpenClaw config has working providers for both infer surfaces. Do not rely only on shell environment variables unless they are also available to the persistent daemon service.

## Hard boundary: never change the user's agent LLM

This installer may configure speech-to-text and text-to-speech only. It must never change the user's normal chat/agent LLM selection.

Do **not**:

- run `openclaw onboard` as part of this installer;
- edit, set, merge, remove, or repair `agents.defaults.model`, `agents.defaults.models`, `agents.*.model`, `models.default`, or equivalent default-chat-model fields;
- switch the main/default agent to OpenAI, xAI, Grok, GPT, Claude, or any other provider.

Provider keys used for STT/TTS are not permission to change the agent model.

Before making OpenClaw config changes, snapshot agent model defaults and verify they are identical afterward:

```bash
openclaw config get agents.defaults --json > /tmp/clawkie-agents-defaults-before.json 2>/dev/null || true
openclaw config get agents --json > /tmp/clawkie-agents-before.json 2>/dev/null || true

# perform only infer/STT/TTS config commands

openclaw config get agents.defaults --json > /tmp/clawkie-agents-defaults-after.json 2>/dev/null || true
openclaw config get agents --json > /tmp/clawkie-agents-after.json 2>/dev/null || true
diff -u /tmp/clawkie-agents-defaults-before.json /tmp/clawkie-agents-defaults-after.json
diff -u /tmp/clawkie-agents-before.json /tmp/clawkie-agents-after.json
```

Those diffs must be empty or explain only unrelated pre-existing timestamp/order noise. Any substantive agent model/default change means the installer failed and must be reverted.

## Inspect infer providers

```bash
openclaw infer audio providers --json
openclaw infer tts providers --json
```

Requirements:

- `openclaw infer audio providers --json` must show at least one transcription provider with `configured: true`, or `tools.media.audio.models` must point at a working CLI fallback.
- `openclaw infer tts providers --json` must show at least one usable speech provider.
- `openclaw infer tts voices --provider <provider> --json` should list voices or return a provider-specific success response.
- `openclaw infer tts convert ... --json` must create an output file.
- `ffmpeg` must be able to decode that TTS output to PCM from the same user/service environment that runs the daemon.

If infer is not configured, do **not** improvise by installing random local speech packages, building `whisper-cpp`, editing protected OpenClaw config files directly, or relying on a no-key TTS provider by itself.

## Repair responsibility

If the user's OpenClaw install does not have infer audio/TTS configured or auto-detectable, Clawkie Talkie is not installed successfully yet. The daemon may print a Join URL and accept a phone connection, but the first voice turn will fail at runtime.

Installer responsibility:

1. Do not report success and do not leave this as a runtime problem for the user.
2. Configure or repair the missing OpenClaw infer surface for the same OS user that will run the daemon.
3. Prefer an already-authenticated OpenClaw provider or already-installed local CLI.
4. Preserve existing working provider config and only add missing audio/TTS pieces.
5. If multiple providers are available and the user has not named or already configured an intended provider, choose the least invasive working option and state what was chosen in the final report. If a provider is named, already has an API key/config, or is otherwise identified as intended, repair that provider's STT/TTS infer surfaces instead; do not substitute another provider as the final fix unless the user explicitly approves changing providers.
6. If no usable provider credentials or local CLI are available, stop with a concrete blocker: failed command, missing config surface, and the safe auth/config step the user must provide.
7. Do not ask the user to paste secrets into chat.
8. Rerun smoke tests after every config change.

## Generic config shape

Use OpenClaw config tooling rather than hand-editing when possible. Replace placeholders with a provider/model for which the user already has credentials:

```bash
openclaw config set tools.media.audio '{"enabled":true,"models":[{"type":"provider","provider":"<stt-provider>","model":"<stt-model>"}]}' --strict-json --merge
openclaw config set messages.tts '{"provider":"<tts-provider>","providers":{"<tts-provider>":{}}}' --strict-json --merge
```

If the user already has OpenAI, Deepgram, ElevenLabs, Microsoft, or another supported provider configured and the smoke tests pass, keep it. If a provider uses SecretRefs, verify they resolve for the daemon's user account.

## Recommended hosted providers

Recommended choices when no provider works yet:

1. **OpenAI** — best default for most users because it supports both STT and TTS in OpenClaw.
2. **xAI** — good alternative if the user has or prefers an xAI API key; it also supports both STT and TTS in OpenClaw.

If the user already has one of these keys, ask which provider they want. Then prompt for the key locally in the terminal with hidden input. The user supplies only the secret; you run config and verification.

## OpenAI infer setup

Use this when the user chooses OpenAI or already has an OpenAI API key available locally. If the OpenAI provider already exists, preserve its current model list/defaults; otherwise add minimal provider metadata for direct OpenAI API calls.

```bash
read -rsp "Paste OpenAI API key for this machine, then press Enter: " OPENAI_KEY
printf '\n'
test -n "$OPENAI_KEY" || { echo "No key entered; cannot configure OpenAI infer" >&2; exit 1; }

# STT/model-provider auth metadata. This does not select or change the default agent LLM.
# Current OpenClaw provider metadata requires baseUrl, apiKey, and model entries with id/name.
openclaw config set models.providers.openai '{"baseUrl":"https://api.openai.com/v1","apiKey":"'"$OPENAI_KEY"'","models":[{"id":"gpt-4o-mini-transcribe","name":"gpt-4o-mini-transcribe"},{"id":"gpt-4o-mini-tts","name":"gpt-4o-mini-tts"}]}' --strict-json --merge

# STT model used by `openclaw infer audio transcribe`.
openclaw config set tools.media.audio '{"enabled":true,"models":[{"type":"provider","provider":"openai","model":"gpt-4o-mini-transcribe"}]}' --strict-json --merge

# TTS default + auth. This is the config surface used by `openclaw infer tts convert`.
openclaw config set messages.tts '{"provider":"openai","providers":{"openai":{"apiKey":"'"$OPENAI_KEY"'","model":"gpt-4o-mini-tts","voice":"alloy"}}}' --strict-json --merge
unset OPENAI_KEY
```

## xAI infer setup

OpenClaw has separate xAI config surfaces. Do not collapse them into one provider block, and do not treat one xAI surface as proof that the other surface is configured.

For Clawkie Talkie:

- STT uses `models.providers.xai` for xAI auth/metadata and `tools.media.audio.models` to select the transcription model.
- TTS uses `messages.tts.provider = "xai"` and `messages.tts.providers.xai.apiKey` plus `voiceId`.
- xAI TTS is voice-based. `openclaw infer tts providers --json` may show xAI with `models: []`; that is not a reason to switch providers.
- xAI TTS does **not** become configured by adding `grok-tts` to `models.providers.xai.models`.
- If TTS conversion reports `not_configured` or falls back to Microsoft/another provider, fix `messages.tts.provider` and `messages.tts.providers.xai.apiKey` for the same process/user running the command.
- If an xAI API key exists only under `models.providers.xai`, copy/wire the same existing key into the supported xAI TTS config surface without printing it, or report the exact blocker.
- Microsoft or another provider passing TTS does not satisfy an xAI Clawkie Talkie install unless the user explicitly approved changing providers.
- The TTS CLI `--model` override, if used, must be a provider/model ref such as `openai/gpt-4o-mini-tts`; `--model xai` is invalid. Prefer setting `messages.tts.provider` and smoke-testing without a model override.

```bash
read -rsp "Paste xAI API key for this machine, then press Enter: " XAI_KEY
printf '\n'
test -n "$XAI_KEY" || { echo "No key entered; cannot configure xAI infer" >&2; exit 1; }

# STT/model-provider auth metadata. This does not select or change the default agent LLM.
openclaw config set models.providers.xai '{"apiKey":"'"$XAI_KEY"'"}' --strict-json --merge

# STT model used by `openclaw infer audio transcribe`.
openclaw config set tools.media.audio '{"enabled":true,"models":[{"type":"provider","provider":"xai","model":"grok-2-vision-latest"}]}' --strict-json --merge

# TTS default + auth. This is the config surface used by `openclaw infer tts convert`.
openclaw config set messages.tts '{"provider":"xai","providers":{"xai":{"apiKey":"'"$XAI_KEY"'","voiceId":"eve"}}}' --strict-json --merge
unset XAI_KEY
```

## Smoke tests

```bash
TTS_PROVIDER=<configured-tts-provider>
rm -f /tmp/clawkie-openclaw-infer-smoke.mp3
openclaw infer tts voices --provider "$TTS_PROVIDER" --json || openclaw infer tts voices --json
openclaw infer tts convert \
  --text "clawkie infer smoke test" \
  --output /tmp/clawkie-openclaw-infer-smoke.mp3 \
  --json
test -s /tmp/clawkie-openclaw-infer-smoke.mp3
ffmpeg -hide_banner -loglevel error \
  -i /tmp/clawkie-openclaw-infer-smoke.mp3 \
  -f s16le -acodec pcm_s16le -ac 1 -ar 24000 \
  /tmp/clawkie-openclaw-infer-smoke.pcm
test -s /tmp/clawkie-openclaw-infer-smoke.pcm
openclaw infer audio transcribe --file /tmp/clawkie-openclaw-infer-smoke.mp3 --json
```

If TTS passes but the `ffmpeg` decode step fails, install/fix `ffmpeg` for the daemon user or service environment. If TTS passes but audio transcription fails, fix `tools.media.audio`. If audio transcription passes but TTS fails, fix `messages.tts`.
