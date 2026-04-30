import { execFile } from 'node:child_process';
import type {
  SttCatalog,
  SttCatalogProvider,
  TtsCatalog,
  TtsCatalogProvider,
  TtsCatalogVoice,
} from './protocol.js';

export interface InferTranscribeCommandOptions {
  filePath: string;
  language?: string;
  model?: string;
}

export interface InferTtsCommandOptions {
  text: string;
  outputPath: string;
  voice?: string;
  model?: string;
}

export interface InferCommand {
  command: 'openclaw';
  args: string[];
}

export type InferTranscribeCommand = InferCommand;
export type InferTtsCommand = InferCommand;
export type InferTtsProvidersCommand = InferCommand;
export type InferAudioProvidersCommand = InferCommand;

export interface OpenClawInferExecRequest {
  command: string;
  args: string[];
  signal?: AbortSignal;
}

export interface OpenClawInferExecResult {
  stdout: string;
  stderr?: string;
}

export type OpenClawInferExec = (
  request: OpenClawInferExecRequest,
) => Promise<OpenClawInferExecResult>;

export interface TranscribeWithOpenClawInferOptions {
  wavPath: string;
  language?: string;
  model?: string;
  signal?: AbortSignal;
  exec?: OpenClawInferExec;
}

interface InferTranscriptEnvelope {
  ok?: boolean;
  error?: unknown;
  outputs?: Array<{ text?: unknown }>;
}

interface InferTtsEnvelope {
  ok?: boolean;
  error?: unknown;
  outputs?: Array<{ path?: unknown }>;
}

interface InferTtsProvidersEnvelope {
  active?: unknown;
  providers?: unknown;
}

export class OpenClawInferError extends Error {
  readonly code = 'openclaw_infer_stt_failed';
  readonly stderr?: string;

  constructor(message: string, opts?: { stderr?: string; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.name = 'OpenClawInferError';
    this.stderr = opts?.stderr;
  }
}

export function buildInferTranscribeCommand(
  opts: InferTranscribeCommandOptions,
): InferTranscribeCommand {
  const args = ['infer', 'audio', 'transcribe', '--file', opts.filePath, '--json'];
  if (opts.language) args.push('--language', opts.language);
  if (opts.model) args.push('--model', opts.model);
  return { command: 'openclaw', args };
}

export function buildInferTtsProvidersCommand(): InferTtsProvidersCommand {
  return { command: 'openclaw', args: ['infer', 'tts', 'providers', '--json'] };
}

export function buildInferAudioProvidersCommand(): InferAudioProvidersCommand {
  return { command: 'openclaw', args: ['infer', 'audio', 'providers', '--json'] };
}

export function buildInferTtsCommand(opts: InferTtsCommandOptions): InferTtsCommand {
  const args = [
    'infer',
    'tts',
    'convert',
    '--text',
    opts.text,
    '--output',
    opts.outputPath,
    '--json',
  ];
  if (opts.model) args.push('--model', opts.model);
  const voice = normalizeOpenClawInferTtsVoice(opts.voice);
  if (voice) args.push('--voice', voice);
  return { command: 'openclaw', args };
}

export function normalizeOpenClawInferTtsVoice(voice: string | undefined): string | undefined {
  const candidate = voice?.trim();
  if (!candidate) return undefined;
  return candidate;
}

export function parseInferTranscript(stdout: string): string {
  let parsed: InferTranscriptEnvelope;
  try {
    parsed = JSON.parse(stdout) as InferTranscriptEnvelope;
  } catch (error) {
    throw new Error('Invalid OpenClaw infer JSON');
  }

  if (parsed.ok === false) {
    const detail = typeof parsed.error === 'string' ? `: ${parsed.error}` : '';
    throw new Error(`OpenClaw infer transcription failed${detail}`);
  }

  const text = parsed.outputs?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('OpenClaw infer output missing transcript text');
  }

  return text;
}

export function parseInferTtsOutput(stdout: string): void {
  let parsed: InferTtsEnvelope;
  try {
    parsed = JSON.parse(stdout) as InferTtsEnvelope;
  } catch {
    throw new Error('Invalid OpenClaw infer JSON');
  }

  if (parsed.ok === false) {
    const detail = typeof parsed.error === 'string' ? `: ${parsed.error}` : '';
    throw new Error(`OpenClaw infer TTS failed${detail}`);
  }

  const path = parsed.outputs?.[0]?.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('OpenClaw infer output missing TTS path');
  }
}

export function parseInferTtsProviders(stdout: string): TtsCatalog {
  let parsed: InferTtsProvidersEnvelope;
  try {
    parsed = JSON.parse(stdout) as InferTtsProvidersEnvelope;
  } catch {
    throw new Error('Invalid OpenClaw infer TTS providers JSON');
  }

  if (!Array.isArray(parsed.providers)) {
    throw new Error('OpenClaw infer TTS providers output missing providers');
  }

  const providers = parsed.providers.map((provider, index) =>
    normalizeTtsCatalogProvider(provider, index),
  );
  const selectedProvider = providers.find((provider) => provider.selected);

  return {
    activeProvider:
      typeof parsed.active === 'string' ? parsed.active : selectedProvider?.id ?? '',
    generatedAt: new Date().toISOString(),
    providers,
  };
}

export async function transcribeWithOpenClawInfer(
  opts: TranscribeWithOpenClawInferOptions,
): Promise<string> {
  const command = buildInferTranscribeCommand({
    filePath: opts.wavPath,
    language: opts.language,
    model: opts.model,
  });
  const runExec = opts.exec ?? execOpenClawInfer;

  try {
    const result = await runExec({ ...command, signal: opts.signal });
    return parseInferTranscript(result.stdout);
  } catch (error) {
    if (error instanceof OpenClawInferError) throw error;
    const stderr = stderrFromError(error);
    const detail = stderr ? `: ${stderr}` : errorMessage(error);
    throw new OpenClawInferError(`openclaw_infer_stt_failed${detail}`, {
      stderr,
      cause: error,
    });
  }
}

export interface SynthesizeTtsWithOpenClawInferOptions {
  text: string;
  outputPath: string;
  voice?: string;
  model?: string;
  signal?: AbortSignal;
  exec?: OpenClawInferExec;
}

export async function synthesizeTtsWithOpenClawInfer(
  opts: SynthesizeTtsWithOpenClawInferOptions,
): Promise<void> {
  const command = buildInferTtsCommand({
    text: opts.text,
    outputPath: opts.outputPath,
    voice: opts.voice,
    model: opts.model,
  });
  const runExec = opts.exec ?? execOpenClawInfer;

  try {
    const result = await runExec({ ...command, signal: opts.signal });
    parseInferTtsOutput(result.stdout);
  } catch (error) {
    if (error instanceof OpenClawInferError) throw error;
    const stderr = stderrFromError(error);
    const detail = stderr ? `: ${stderr}` : errorMessage(error);
    throw new Error(`openclaw_infer_tts_failed${detail}`, { cause: error });
  }
}

export function parseInferAudioProviders(stdout: string): SttCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Invalid OpenClaw infer audio providers JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('OpenClaw infer audio providers output must be an array');
  }

  const providers: SttCatalogProvider[] = [];
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`OpenClaw infer audio provider at index ${index} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    const capabilities = normalizeStringArray(record.capabilities);
    if (!capabilities.includes('audio')) return;
    if (typeof record.id !== 'string' || record.id.length === 0) {
      throw new Error(`OpenClaw infer audio provider missing id at index ${index}`);
    }
    const defaultModels = (record.defaultModels && typeof record.defaultModels === 'object'
      ? (record.defaultModels as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    const audioModel =
      typeof defaultModels.audio === 'string' && defaultModels.audio.length > 0
        ? defaultModels.audio
        : undefined;
    providers.push({
      id: record.id,
      name:
        typeof record.name === 'string' && record.name.length > 0 ? record.name : record.id,
      configured: record.configured === true,
      selected: record.selected === true,
      available: record.available === true,
      models: audioModel ? [audioModel] : [],
    });
  });

  const selected = providers.find((provider) => provider.selected);
  return {
    activeProvider: selected?.id,
    generatedAt: new Date().toISOString(),
    providers,
  };
}

export async function getSttCatalogWithOpenClawInfer(opts: {
  exec?: OpenClawInferExec;
  signal?: AbortSignal;
} = {}): Promise<SttCatalog> {
  const command = buildInferAudioProvidersCommand();
  const runExec = opts.exec ?? execOpenClawInfer;

  try {
    const request: OpenClawInferExecRequest = { ...command };
    if (opts.signal) request.signal = opts.signal;
    const result = await runExec(request);
    return parseInferAudioProviders(result.stdout);
  } catch (error) {
    const stderr = stderrFromError(error);
    const detail = stderr ? `: ${stderr}` : errorMessage(error);
    throw Object.assign(
      new Error(`openclaw_infer_stt_catalog_failed${detail}`, { cause: error }),
      {
        code: 'openclaw_infer_stt_catalog_failed',
        stderr,
      },
    );
  }
}

export async function getTtsCatalogWithOpenClawInfer(opts: {
  exec?: OpenClawInferExec;
  signal?: AbortSignal;
} = {}): Promise<TtsCatalog> {
  const command = buildInferTtsProvidersCommand();
  const runExec = opts.exec ?? execOpenClawInfer;

  try {
    const result = await runExec({ ...command, signal: opts.signal });
    return parseInferTtsProviders(result.stdout);
  } catch (error) {
    const stderr = stderrFromError(error);
    const detail = stderr ? `: ${stderr}` : errorMessage(error);
    throw Object.assign(
      new Error(`openclaw_infer_tts_catalog_failed${detail}`, { cause: error }),
      {
        code: 'openclaw_infer_tts_catalog_failed',
        stderr,
      },
    );
  }
}

function normalizeTtsCatalogProvider(provider: unknown, index: number): TtsCatalogProvider {
  if (typeof provider !== 'object' || provider === null) {
    throw new Error(`OpenClaw infer TTS provider at index ${index} is not an object`);
  }

  const record = provider as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error(`OpenClaw infer TTS provider missing id at index ${index}`);
  }

  return {
    id: record.id,
    name: typeof record.name === 'string' && record.name.length > 0 ? record.name : record.id,
    configured: record.configured === true,
    selected: record.selected === true,
    available: record.available === true,
    models: normalizeStringArray(record.models),
    voices: normalizeTtsCatalogVoices(record.voices, index),
  };
}

function normalizeTtsCatalogVoices(voices: unknown, providerIndex: number): TtsCatalogVoice[] {
  if (!Array.isArray(voices)) return [];

  return voices.map((voice, index) => {
    if (typeof voice === 'string') return { id: voice, name: voice };

    if (typeof voice === 'object' && voice !== null) {
      const record = voice as Record<string, unknown>;
      if (typeof record.id === 'string' && record.id.length > 0) {
        return {
          id: record.id,
          name: typeof record.name === 'string' && record.name.length > 0 ? record.name : record.id,
        };
      }
    }

    throw new Error(
      `OpenClaw infer TTS provider at index ${providerIndex} has invalid voice at index ${index}`,
    );
  });
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function execOpenClawInfer(request: OpenClawInferExecRequest): Promise<OpenClawInferExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      request.command,
      request.args,
      { signal: request.signal },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function stderrFromError(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return undefined;
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' && stderr.length > 0 ? stderr : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? `: ${error.message}` : '';
}
