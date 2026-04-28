import { execFile } from 'node:child_process';

export interface InferTranscribeCommandOptions {
  filePath: string;
  language?: string;
  model?: string;
}

export interface InferTranscribeCommand {
  command: 'openclaw';
  args: string[];
}

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
