#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const REQUIRED_AGENT_SCOPES = ['operator.pairing', 'operator.read', 'operator.write'];

const DEFAULT_AGENT_MESSAGE = 'Clawkie Talkie install smoke test. Reply with exactly: ok';
const CHECK_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MIN_NODE_MAJOR = 22;
const MIN_OPENCLAW_VERSION = { year: 2026, month: 4, patch: 25 };
const MIN_OPENCLAW_VERSION_TEXT = '2026.4.25';
export const STT_SMOKE_FIXTURE_PATH = fileURLToPath(new URL('../client/public/fixtures/stt-check-hi.wav', import.meta.url));

export function parseArgs(argv) {
  const opts = {
    sessionId: '',
    agentTurn: false,
    requireAgentTurn: false,
    deliver: false,
    replyChannel: '',
    replyTo: '',
    replyAccount: '',
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    skipInfer: false,
    sttLanguage: '',
    json: false,
    help: false,
    agentMessage: DEFAULT_AGENT_MESSAGE,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--agent-turn') opts.agentTurn = true;
    else if (arg === '--require-agent-turn') opts.requireAgentTurn = true;
    else if (arg === '--deliver') opts.deliver = true;
    else if (arg === '--skip-infer') opts.skipInfer = true;
    else if (arg === '--session-id' || arg === '--session') opts.sessionId = requireValue(argv, ++i, arg);
    else if (arg === '--reply-channel') opts.replyChannel = requireValue(argv, ++i, arg);
    else if (arg === '--reply-to') opts.replyTo = requireValue(argv, ++i, arg);
    else if (arg === '--reply-account') opts.replyAccount = requireValue(argv, ++i, arg);
    else if (arg === '--stt-language') opts.sttLanguage = requireValue(argv, ++i, arg);
    else if (arg === '--agent-message') opts.agentMessage = requireValue(argv, ++i, arg);
    else if (arg === '--timeout') opts.timeoutSeconds = parseTimeoutSeconds(requireValue(argv, ++i, arg));
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (opts.sessionId || opts.requireAgentTurn) opts.agentTurn = true;
  return opts;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseTimeoutSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout requires a positive number of seconds');
  return seconds;
}

export function usage() {
  return `Usage: node scripts/agent-install-preflight.mjs [options]

Checks Node/npm, OpenClaw status, and infer STT/TTS for a Clawkie Talkie install.

Agent-turn smoke command (with --session-id):
  openclaw agent --agent main --session-id <session> --json --timeout <seconds> -m <message>

Delivered smoke command (with --deliver):
  openclaw agent --agent main --session-id <session> --deliver --reply-channel <channel> --reply-to <target> --json --timeout <seconds> -m <message>

Options:
  --session-id <session>              Run the OpenClaw agent-turn smoke test for the real stored session id/UUID.
  --agent-turn                        Also run the OpenClaw agent-turn smoke test (requires --session-id).
  --require-agent-turn                Fail before other checks if --session-id is missing.
  --deliver                           Opt in to delivering the agent-turn smoke reply.
                                      Requires --reply-channel and --reply-to.
  --reply-channel <channel>           Explicit delivery channel for --deliver smoke tests.
  --reply-to <target>                 Explicit delivery target for --deliver smoke tests.
  --reply-account <accountId>         Optional delivery account for --deliver smoke tests.
                                      Without --deliver, the smoke test does not post a reply.
  --timeout <seconds>                 Timeout passed to openclaw agent (default: ${DEFAULT_TIMEOUT_SECONDS}).
  --stt-language <code>               Pass a language hint to infer audio transcribe.
  --skip-infer                        Skip STT/TTS infer checks.
  --agent-message <text>              Override the agent-turn smoke-test prompt.
  --json                              Print machine-readable JSON.
  -h, --help                          Show this help.
`;
}

export async function runPreflight(options = {}, deps = {}) {
  const runCommand = deps.runCommand ?? runCommandWithSpawn;
  const tempRoot = deps.tempRoot ?? tmpdir();
  const cwd = deps.cwd ?? process.cwd();
  const checks = [];
  const timeoutSeconds = normalizeTimeoutSeconds(options.timeoutSeconds);
  const agentCommandTimeoutMs = Math.ceil(timeoutSeconds * 1000) + 5000;
  const sessionId = String(options.sessionId ?? '').trim();

  if (options.requireAgentTurn && !sessionId) {
    checks.push(missingSessionIdCheck('Agent-turn smoke is required (--require-agent-turn), but no --session-id was provided.'));
    return summarize(checks);
  }

  const nodeVersion = checkNodeVersion(deps.nodeVersion ?? process.versions.node);
  checks.push(nodeVersion);
  if (nodeVersion.status !== 'pass') return summarize(checks);

  const npm = await runNamedCheck('npm-presence', {
    command: 'npm',
    args: ['--version'],
    timeoutMs: 10_000,
    cwd,
    runCommand,
    validate: validateNpmVersion,
    classify: classifyNpmFailure,
  });
  checks.push(npm);
  if (npm.status !== 'pass') return summarize(checks);

  const openclawVersion = await runNamedCheck('openclaw-version', {
    command: 'openclaw',
    args: ['--version'],
    timeoutMs: 10_000,
    cwd,
    runCommand,
    validate: validateOpenClawVersion,
  });
  checks.push(openclawVersion);
  if (openclawVersion.status !== 'pass') return summarize(checks);

  const status = await runNamedCheck('openclaw-status', {
    command: 'openclaw',
    args: ['status', '--json'],
    timeoutMs: CHECK_TIMEOUT_MS,
    cwd,
    runCommand,
    validate: validateOpenClawStatusJson,
  });
  checks.push(status);
  if (status.status !== 'pass') return summarize(checks);

  if (!options.skipInfer) {
    const ffmpeg = await runFfmpegPresenceCheck({ runCommand, cwd });
    checks.push(ffmpeg);
    if (ffmpeg.status !== 'pass') return summarize(checks);

    const stt = await runSttCheck({ runCommand, cwd, language: options.sttLanguage });
    checks.push(stt);
    if (stt.status !== 'pass') return summarize(checks);

    const ttsChecks = await runTtsChecks({ runCommand, tempRoot, cwd });
    checks.push(...ttsChecks);
    const failedTtsCheck = ttsChecks.find((check) => check.status !== 'pass');
    if (failedTtsCheck) return summarize(checks);
  }

  const agentTurnRequested = Boolean(options.agentTurn || sessionId);
  if (agentTurnRequested) {
    if (!sessionId) {
      checks.push(missingSessionIdCheck('Agent-turn smoke requested, but no real --session-id was provided.'));
      return summarize(checks);
    }

    const replyChannel = String(options.replyChannel ?? '').trim();
    const replyTo = String(options.replyTo ?? '').trim();
    const replyAccount = String(options.replyAccount ?? '').trim();
    if (options.deliver && (!replyChannel || !replyTo)) {
      checks.push(missingReplyTargetCheck('Delivered agent-turn smoke requested, but --reply-channel and --reply-to were not provided.'));
      return summarize(checks);
    }

    const agentArgs = [
      'agent',
      '--agent', 'main',
      '--session-id', sessionId,
    ];
    if (options.deliver) {
      agentArgs.push('--deliver', '--reply-channel', replyChannel, '--reply-to', replyTo);
      if (replyAccount) agentArgs.push('--reply-account', replyAccount);
    }
    agentArgs.push(
      '--json',
      '--timeout', String(timeoutSeconds),
      '-m', options.agentMessage || DEFAULT_AGENT_MESSAGE,
    );

    const agentTurn = await runNamedCheck('openclaw-agent-turn', {
      command: 'openclaw',
      args: agentArgs,
      timeoutMs: agentCommandTimeoutMs,
      cwd,
      runCommand,
    });
    checks.push(agentTurn);
    if (agentTurn.status !== 'pass') return summarize(checks);
  }

  return summarize(checks);
}


function normalizeTimeoutSeconds(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_SECONDS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TIMEOUT_SECONDS;
  return seconds;
}

function missingSessionIdCheck(summary) {
  return {
    name: 'openclaw-agent-turn',
    status: 'fail',
    code: 'missing_session_id',
    summary,
  };
}

function missingReplyTargetCheck(summary) {
  return {
    name: 'openclaw-agent-turn',
    status: 'fail',
    code: 'missing_reply_target',
    summary,
  };
}

function checkNodeVersion(version) {
  const text = String(version ?? '').trim();
  const major = Number(text.split('.')[0]);
  if (!Number.isInteger(major)) {
    return {
      name: 'node-version',
      status: 'fail',
      code: 'node_version_unparseable',
      summary: `Could not parse Node version: ${text || '(empty)'}.`,
    };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      name: 'node-version',
      status: 'fail',
      code: 'node_version_too_old',
      summary: `Node ${text} is too old; use Node ${MIN_NODE_MAJOR} LTS or newer.`,
    };
  }
  return {
    name: 'node-version',
    status: 'pass',
    command: 'process.versions.node',
    summary: `Node ${text} is present.`,
  };
}

function validateNpmVersion(result) {
  const stdout = String(result.stdout ?? '').trim();
  return /^\d+\.\d+\.\d+/.test(stdout) ? null : 'npm --version succeeded but did not print a parseable npm version.';
}

function classifyNpmFailure(text) {
  if (/\b(command not found|not found|enoent)\b/i.test(String(text ?? ''))) {
    return { code: 'npm_unavailable', summary: 'npm is unavailable on PATH.' };
  }
  return { code: 'npm_failed', summary: 'npm --version failed.' };
}

function validateOpenClawVersion(result) {
  const stdout = String(result.stdout ?? '').trim();
  const stderr = String(result.stderr ?? '').trim();
  const parsed = parseOpenClawVersion(`${stdout}\n${stderr}`);
  if (!parsed) return null;
  if (compareOpenClawVersions(parsed, MIN_OPENCLAW_VERSION) < 0) {
    return {
      code: 'openclaw_version_too_old',
      summary: `OpenClaw ${formatOpenClawVersion(parsed)} is too old; install/configure OpenClaw ${MIN_OPENCLAW_VERSION_TEXT}+ before continuing.`,
    };
  }
  return null;
}

function validateOpenClawStatusJson(result) {
  const stdout = String(result.stdout ?? '').trim();
  if (!stdout) return 'openclaw status --json succeeded but printed no JSON.';
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return 'openclaw status --json succeeded but stdout was not valid JSON.';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'openclaw status --json did not return a JSON object.';
  }
  if (parsed.ok === false) {
    return `openclaw status --json returned ok:false${parsed.error ? ` (${parsed.error})` : ''}.`;
  }
  return null;
}

function parseOpenClawVersion(text) {
  const match = String(text ?? '').match(/\b(20\d{2})\.(\d{1,2})\.(\d{1,2})\b/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), patch: Number(match[3]) };
}

function compareOpenClawVersions(a, b) {
  for (const key of ['year', 'month', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

function formatOpenClawVersion(version) {
  return `${version.year}.${version.month}.${version.patch}`;
}

async function runSttCheck({ runCommand, cwd, language }) {
  const args = ['infer', 'audio', 'transcribe', '--file', STT_SMOKE_FIXTURE_PATH, '--json'];
  if (language) args.push('--language', language);
  return await runNamedCheck('openclaw-infer-stt', {
    command: 'openclaw',
    args,
    timeoutMs: CHECK_TIMEOUT_MS,
    cwd,
    runCommand,
    validate: validateInferSttJson,
  });
}

async function runFfmpegPresenceCheck({ runCommand, cwd }) {
  return await runNamedCheck('ffmpeg-presence', {
    command: 'sh',
    args: ['-lc', 'command -v ffmpeg'],
    timeoutMs: 10_000,
    cwd,
    runCommand,
    validate: (result) => String(result.stdout ?? '').trim() ? null : 'command -v ffmpeg succeeded but printed no path.',
    classify: classifyFfmpegFailure,
  });
}

async function runTtsChecks({ runCommand, tempRoot, cwd }) {
  const dir = await mkdtemp(join(tempRoot, 'clawkie-preflight-tts-'));
  try {
    const outputPath = join(dir, 'reply.mp3');
    const pcmPath = join(dir, 'reply.pcm');
    const tts = await runNamedCheck('openclaw-infer-tts', {
      command: 'openclaw',
      args: [
        'infer', 'tts', 'convert',
        '--text', 'Clawkie Talkie install TTS smoke test.',
        '--output', outputPath,
        '--json',
      ],
      timeoutMs: CHECK_TIMEOUT_MS,
      cwd,
      runCommand,
      validate: async (result) => {
        const jsonValidation = validateInferJson(result);
        if (jsonValidation) return jsonValidation;
        if (!existsSync(outputPath)) return 'TTS command succeeded but did not create the output file.';
        const info = await stat(outputPath);
        return info.size > 0 ? null : 'TTS command created an empty output file.';
      },
    });
    if (tts.status !== 'pass') return [tts];

    const decode = await runNamedCheck('ffmpeg-tts-decode', {
      command: 'ffmpeg',
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        outputPath,
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        '24000',
        '-y',
        pcmPath,
      ],
      timeoutMs: CHECK_TIMEOUT_MS,
      cwd,
      runCommand,
      validate: async () => {
        if (!existsSync(pcmPath)) return 'ffmpeg decode succeeded but did not create the PCM output file.';
        const info = await stat(pcmPath);
        return info.size > 0 ? null : 'ffmpeg decode created an empty PCM output file.';
      },
      classify: classifyFfmpegDecodeFailure,
    });

    return [tts, decode];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runNamedCheck(name, spec) {
  const result = await spec.runCommand(spec.command, spec.args, {
    timeoutMs: spec.timeoutMs,
    cwd: spec.cwd,
  });
  const text = collectResultText(result);
  const failure = (spec.classify ?? classifyPreflightFailure)(text);

  if (result.exitCode === 0 && !result.error) {
    const validationError = normalizeValidationError(spec.validate ? await spec.validate(result) : null);
    if (!validationError) {
      return {
        name,
        status: 'pass',
        command: shellCommand(spec.command, spec.args),
        summary: 'passed',
      };
    }
    return {
      name,
      status: 'fail',
      code: validationError.code,
      command: shellCommand(spec.command, spec.args),
      summary: validationError.summary,
      stdout: trimForReport(result.stdout),
      stderr: trimForReport(result.stderr),
    };
  }

  return {
    name,
    status: 'fail',
    code: failure.code,
    command: shellCommand(spec.command, spec.args),
    summary: failure.summary,
    requestId: failure.requestId,
    approveCommand: failure.approveCommand,
    requiredScopes: failure.requiredScopes,
    stdout: trimForReport(result.stdout),
    stderr: trimForReport(result.stderr),
    exitCode: result.exitCode,
    error: result.error,
  };
}


function normalizeValidationError(error) {
  if (!error) return null;
  if (typeof error === 'string') return { code: 'invalid_success_output', summary: error };
  return {
    code: error.code || 'invalid_success_output',
    summary: error.summary || String(error),
  };
}

function validateInferJson(result) {
  const stdout = String(result.stdout ?? '').trim();
  if (!stdout) return 'Infer command succeeded but printed no JSON.';
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && 'ok' in parsed && parsed.ok === false) {
      return `Infer command returned ok:false${parsed.error ? ` (${parsed.error})` : ''}.`;
    }
    return null;
  } catch {
    return 'Infer command succeeded but stdout was not valid JSON.';
  }
}

function validateInferSttJson(result) {
  const jsonValidation = validateInferJson(result);
  if (jsonValidation) return jsonValidation;
  const parsed = JSON.parse(String(result.stdout ?? '').trim());
  const transcripts = Array.isArray(parsed?.outputs)
    ? parsed.outputs
      .map((output) => output?.text)
      .filter((text) => typeof text === 'string')
    : [];
  const nonEmptyTranscripts = transcripts.filter((text) => text.trim());
  if (nonEmptyTranscripts.length === 0) {
    return 'STT command succeeded but did not return a non-empty transcript.';
  }
  if (nonEmptyTranscripts.some((text) => normalizeTranscriptText(text) === 'hi')) return null;
  return 'STT command succeeded but did not transcribe the expected fixture text: Hi!';
}

function normalizeTranscriptText(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function classifyFfmpegFailure(text) {
  const raw = String(text ?? '');
  if (/\b(command not found|not found|enoent)\b/i.test(raw)) {
    return { code: 'ffmpeg_unavailable', summary: 'ffmpeg is unavailable on PATH for this user/service environment.' };
  }
  return { code: 'ffmpeg_failed', summary: 'ffmpeg availability check failed.' };
}

function classifyFfmpegDecodeFailure(text) {
  const raw = String(text ?? '');
  if (/\b(command not found|not found|enoent)\b/i.test(raw)) {
    return { code: 'ffmpeg_unavailable', summary: 'ffmpeg is unavailable on PATH for this user/service environment.' };
  }
  return { code: 'ffmpeg_tts_decode_failed', summary: 'ffmpeg could not decode the OpenClaw TTS output to daemon PCM16LE audio.' };
}

export function classifyPreflightFailure(text) {
  const raw = String(text ?? '');
  const lower = raw.toLowerCase();
  const approval = extractApproval(raw);
  if (
    lower.includes('scope upgrade pending approval') ||
    lower.includes('pending device approval') ||
    lower.includes('pending pairing') ||
    lower.includes('pending approval') && (lower.includes('operator.') || lower.includes('openclaw devices approve')) ||
    approval.approveCommand
  ) {
    return {
      code: 'openclaw_scope_approval_pending',
      summary: `OpenClaw agent-turn scope/device approval is pending. openclaw status and infer may pass, but voice replies are blocked until the local gateway approves upgraded scopes: ${REQUIRED_AGENT_SCOPES.join(', ')}.`,
      requestId: approval.requestId,
      approveCommand: approval.approveCommand,
      requiredScopes: REQUIRED_AGENT_SCOPES,
    };
  }

  if (/\b(command not found|not found|enoent)\b/i.test(raw)) {
    return { code: 'openclaw_unavailable', summary: 'openclaw CLI is unavailable on PATH.' };
  }
  if (/\b(auth|token|credential|unauthorized|forbidden|device-auth|read-only file system|erofs)\b/i.test(raw)) {
    return { code: 'openclaw_auth_unavailable', summary: 'OpenClaw authentication is unavailable for this user/environment.' };
  }
  if (/\b(econnrefused|gateway|fetch failed|failed to connect|127\.0\.0\.1|18789)\b/i.test(raw)) {
    return { code: 'openclaw_gateway_unavailable', summary: 'OpenClaw gateway is unreachable from this user/environment.' };
  }
  if (/\bdelivery channel is required\b/i.test(raw)) {
    return { code: 'openclaw_delivery_unavailable', summary: 'OpenClaw agent delivery channel is unavailable for the supplied session.' };
  }

  return { code: 'openclaw_failed', summary: 'OpenClaw command failed.' };
}

function extractApproval(text) {
  const requestId =
    text.match(/openclaw\s+devices\s+approve\s+([A-Za-z0-9._:-]+)/i)?.[1] ??
    text.match(/request\s*id\s*[:=]?\s*([A-Za-z0-9._:-]+)/i)?.[1] ??
    text.match(/requestId\s*[:=]?\s*([A-Za-z0-9._:-]+)/)?.[1] ??
    text.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1];
  const approveCommand = text.match(/openclaw\s+devices\s+approve\s+[A-Za-z0-9._:-]+/i)?.[0] ??
    (requestId ? `openclaw devices approve ${requestId}` : undefined);
  return { requestId, approveCommand };
}

function summarize(checks) {
  const failed = checks.find((check) => check.status !== 'pass');
  return {
    ok: !failed,
    exitCode: failed ? (failed.code === 'openclaw_scope_approval_pending' ? 20 : 1) : 0,
    checks,
  };
}

export async function runCommandWithSpawn(command, args, opts = {}) {
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      resolve({ stdout, stderr, exitCode: null, error: `timed out after ${opts.timeoutMs}ms` });
      settled = true;
    }, opts.timeoutMs ?? CHECK_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({ stdout, stderr, exitCode: null, error: err.message });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({ stdout, stderr, exitCode: code, signal });
    });
  });
}

function collectResultText(result) {
  return [result.error, result.stdout, result.stderr]
    .filter((part) => typeof part === 'string' && part.trim())
    .join('\n');
}

function trimForReport(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length <= 1200) return trimmed;
  return `${trimmed.slice(0, 1200)}…`;
}

function shellCommand(command, args) {
  return [command, ...args].map((part) => JSON.stringify(part)).join(' ');
}

function printHuman(result) {
  console.log('Clawkie Talkie install preflight');
  for (const check of result.checks) {
    const mark = check.status === 'pass' ? 'PASS' : 'FAIL';
    console.log(`- ${mark} ${check.name}: ${check.summary}`);
    if (check.code === 'openclaw_scope_approval_pending') {
      console.log('  Relevant gate: agent-turn smoke test, not status/infer.');
      console.log(`  Required local gateway scopes: ${REQUIRED_AGENT_SCOPES.join(', ')}`);
      if (check.requestId) console.log(`  Request ID: ${check.requestId}`);
      if (check.approveCommand) console.log(`  Approval command: ${check.approveCommand}`);
    }
  }
  if (!result.ok) process.exitCode = result.exitCode;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    console.log(usage());
    return;
  }

  const result = await runPreflight(opts);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = result.exitCode;
  } else {
    printHuman(result);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exitCode = 1;
  });
}
