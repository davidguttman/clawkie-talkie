import { describe, expect, it } from 'vitest';
import { pcm16ToWavBuffer } from '../daemon/src/audio';
import {
  buildInferTranscribeCommand,
  parseInferTranscript,
  transcribeWithOpenClawInfer,
} from '../daemon/src/openclawInfer';

describe('pcm16ToWavBuffer', () => {
  it('writes a valid mono PCM16 WAV header for 16 kHz audio', () => {
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(1000, 0);
    pcm.writeInt16LE(-1000, 2);
    pcm.writeInt16LE(2000, 4);
    pcm.writeInt16LE(-2000, 6);

    const wav = pcm16ToWavBuffer(pcm, 16000);

    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
  });
});

describe('buildInferTranscribeCommand', () => {
  it('builds the default OpenClaw infer transcription command', () => {
    const filePath = '/tmp/turn.wav';

    expect(buildInferTranscribeCommand({ filePath })).toEqual({
      command: 'openclaw',
      args: ['infer', 'audio', 'transcribe', '--file', filePath, '--json'],
    });
  });

  it('appends language when provided', () => {
    const filePath = '/tmp/turn.wav';

    expect(buildInferTranscribeCommand({ filePath, language: 'en' })).toEqual({
      command: 'openclaw',
      args: [
        'infer',
        'audio',
        'transcribe',
        '--file',
        filePath,
        '--json',
        '--language',
        'en',
      ],
    });
  });
});

describe('parseInferTranscript', () => {
  it('extracts the first transcript text from the stable JSON envelope', () => {
    const stdout = JSON.stringify({
      ok: true,
      outputs: [{ text: 'hello from openclaw' }],
    });

    expect(parseInferTranscript(stdout)).toBe('hello from openclaw');
  });

  it('throws a clear error when infer reports ok false', () => {
    const stdout = JSON.stringify({ ok: false, error: 'provider failed' });

    expect(() => parseInferTranscript(stdout)).toThrow(/OpenClaw infer transcription failed/i);
  });

  it('throws a clear error for invalid JSON', () => {
    expect(() => parseInferTranscript('not json')).toThrow(/Invalid OpenClaw infer JSON/i);
  });

  it('returns empty and whitespace transcript text without treating it as missing', () => {
    expect(parseInferTranscript(JSON.stringify({ ok: true, outputs: [{ text: '' }] }))).toBe('');
    expect(parseInferTranscript(JSON.stringify({ ok: true, outputs: [{ text: '   ' }] }))).toBe('   ');
  });

  it('throws a clear error when transcript text is missing or non-string', () => {
    expect(() => parseInferTranscript(JSON.stringify({ ok: true, outputs: [] }))).toThrow(
      /missing transcript text/i,
    );
    expect(() =>
      parseInferTranscript(JSON.stringify({ ok: true, outputs: [{ text: null }] })),
    ).toThrow(/missing transcript text/i);
  });
});

describe('transcribeWithOpenClawInfer', () => {
  it('calls the OpenClaw infer command and returns parsed transcript text', async () => {
    const wavPath = '/tmp/turn.wav';
    const calls: Array<{ command: string; args: string[]; signal?: AbortSignal }> = [];

    const transcript = await transcribeWithOpenClawInfer({
      wavPath,
      exec: async (request) => {
        calls.push(request);
        return {
          stdout: JSON.stringify({ ok: true, outputs: [{ text: 'hello from runner' }] }),
          stderr: '',
        };
      },
    });

    expect(transcript).toBe('hello from runner');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject(buildInferTranscribeCommand({ filePath: wavPath }));
  });

  it('passes language to the OpenClaw infer command when provided', async () => {
    const wavPath = '/tmp/turn.wav';
    const calls: Array<{ command: string; args: string[]; signal?: AbortSignal }> = [];

    await transcribeWithOpenClawInfer({
      wavPath,
      language: 'en',
      exec: async (request) => {
        calls.push(request);
        return {
          stdout: JSON.stringify({ ok: true, outputs: [{ text: 'english transcript' }] }),
          stderr: '',
        };
      },
    });

    expect(calls[0]).toMatchObject(
      buildInferTranscribeCommand({ filePath: wavPath, language: 'en' }),
    );
  });

  it('passes model only when provided to the OpenClaw infer command', async () => {
    const wavPath = '/tmp/turn.wav';
    const calls: Array<{ command: string; args: string[]; signal?: AbortSignal }> = [];

    await transcribeWithOpenClawInfer({
      wavPath,
      model: 'configured/audio-provider',
      exec: async (request) => {
        calls.push(request);
        return {
          stdout: JSON.stringify({ ok: true, outputs: [{ text: 'model transcript' }] }),
          stderr: '',
        };
      },
    });

    expect(calls[0]?.args).toContain('--model');
    expect(calls[0]?.args).toContain('configured/audio-provider');
  });

  it('maps exec failures and stderr to a stable OpenClaw infer error', async () => {
    const failure = Object.assign(new Error('process failed'), { stderr: 'provider exploded' });

    await expect(
      transcribeWithOpenClawInfer({
        wavPath: '/tmp/turn.wav',
        exec: async () => {
          throw failure;
        },
      }),
    ).rejects.toMatchObject({
      code: 'openclaw_infer_stt_failed',
      message: expect.stringContaining('openclaw_infer_stt_failed'),
      stderr: 'provider exploded',
    });
  });

  it('passes AbortSignal to the exec layer', async () => {
    const controller = new AbortController();
    const calls: Array<{ command: string; args: string[]; signal?: AbortSignal }> = [];

    await transcribeWithOpenClawInfer({
      wavPath: '/tmp/turn.wav',
      signal: controller.signal,
      exec: async (request) => {
        calls.push(request);
        return {
          stdout: JSON.stringify({ ok: true, outputs: [{ text: 'not aborted' }] }),
          stderr: '',
        };
      },
    });

    expect(calls[0]?.signal).toBe(controller.signal);
  });
});
