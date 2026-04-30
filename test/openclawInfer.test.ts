import { describe, expect, it } from 'vitest';
import { pcm16ToWavBuffer } from '../daemon/src/audio';
import {
  buildInferAudioProvidersCommand,
  buildInferTranscribeCommand,
  buildInferTtsCommand,
  getSttCatalogWithOpenClawInfer,
  parseInferAudioProviders,
  parseInferTranscript,
  parseInferTtsOutput,
  synthesizeTtsWithOpenClawInfer,
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


describe('buildInferTtsCommand', () => {
  it('builds the default OpenClaw infer TTS command', () => {
    expect(buildInferTtsCommand({ text: 'hello', outputPath: '/tmp/reply.mp3' })).toEqual({
      command: 'openclaw',
      args: [
        'infer',
        'tts',
        'convert',
        '--text',
        'hello',
        '--output',
        '/tmp/reply.mp3',
        '--json',
      ],
    });
  });

  it('appends supported voice and model when provided', () => {
    const command = buildInferTtsCommand({
      text: 'hello',
      outputPath: '/tmp/reply.mp3',
      voice: 'nova',
      model: 'configured/tts-provider',
    });

    expect(command.args).toContain('--voice');
    expect(command.args).toContain('nova');
    expect(command.args).toContain('--model');
    expect(command.args).toContain('configured/tts-provider');
  });

  it('forwards provider-specific voice ids when a model is provided', () => {
    const command = buildInferTtsCommand({
      text: 'hello',
      outputPath: '/tmp/reply.mp3',
      voice: 'eve',
      model: 'xai/tts',
    });

    expect(command.args).toContain('--voice');
    expect(command.args).toContain('eve');
    expect(command.args).toContain('--model');
    expect(command.args).toContain('xai/tts');
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


describe('parseInferTtsOutput', () => {
  it('accepts the stable JSON envelope with an output path', () => {
    expect(() =>
      parseInferTtsOutput(JSON.stringify({ ok: true, outputs: [{ path: '/tmp/reply.mp3' }] })),
    ).not.toThrow();
  });

  it('throws a clear error when infer reports ok false', () => {
    expect(() => parseInferTtsOutput(JSON.stringify({ ok: false, error: 'provider failed' }))).toThrow(
      /OpenClaw infer TTS failed/i,
    );
  });

  it('throws a clear error for invalid JSON or missing path', () => {
    expect(() => parseInferTtsOutput('not json')).toThrow(/Invalid OpenClaw infer JSON/i);
    expect(() => parseInferTtsOutput(JSON.stringify({ ok: true, outputs: [] }))).toThrow(
      /missing TTS path/i,
    );
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


describe('synthesizeTtsWithOpenClawInfer', () => {
  it('calls the OpenClaw infer TTS command and parses the result', async () => {
    const calls: Array<{ command: string; args: string[]; signal?: AbortSignal }> = [];

    await synthesizeTtsWithOpenClawInfer({
      text: 'reply text',
      outputPath: '/tmp/reply.mp3',
      voice: 'nova',
      exec: async (request) => {
        calls.push(request);
        return {
          stdout: JSON.stringify({ ok: true, outputs: [{ path: '/tmp/reply.mp3' }] }),
          stderr: '',
        };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject(
      buildInferTtsCommand({ text: 'reply text', outputPath: '/tmp/reply.mp3', voice: 'nova' }),
    );
  });

  it('maps exec failures to the stable TTS infer error prefix', async () => {
    const failure = Object.assign(new Error('process failed'), { stderr: 'provider exploded' });

    await expect(
      synthesizeTtsWithOpenClawInfer({
        text: 'reply text',
        outputPath: '/tmp/reply.mp3',
        exec: async () => {
          throw failure;
        },
      }),
    ).rejects.toThrow(/openclaw_infer_tts_failed/);
  });
});

describe('buildInferAudioProvidersCommand', () => {
  it('builds the OpenClaw infer audio providers command', () => {
    expect(buildInferAudioProvidersCommand()).toEqual({
      command: 'openclaw',
      args: ['infer', 'audio', 'providers', '--json'],
    });
  });
});

describe('parseInferAudioProviders', () => {
  it('normalizes the bare-array audio provider output', () => {
    const stdout = JSON.stringify([
      {
        available: true,
        configured: true,
        selected: false,
        id: 'xai',
        capabilities: ['audio'],
        defaultModels: { audio: 'grok-stt' },
      },
      {
        available: true,
        configured: true,
        selected: true,
        id: 'openai',
        name: 'OpenAI',
        capabilities: ['audio', 'tts'],
        defaultModels: { audio: 'whisper-1', tts: 'gpt-4o-mini-tts' },
      },
    ]);

    const catalog = parseInferAudioProviders(stdout);

    expect(catalog).toEqual({
      activeProvider: 'openai',
      generatedAt: expect.any(String),
      providers: [
        {
          id: 'xai',
          name: 'xai',
          configured: true,
          selected: false,
          available: true,
          models: ['grok-stt'],
        },
        {
          id: 'openai',
          name: 'OpenAI',
          configured: true,
          selected: true,
          available: true,
          models: ['whisper-1'],
        },
      ],
    });
  });

  it('filters providers without audio capability', () => {
    const stdout = JSON.stringify([
      {
        available: true,
        configured: true,
        id: 'tts-only',
        capabilities: ['tts'],
        defaultModels: { tts: 'voice-1' },
      },
      {
        available: true,
        configured: true,
        id: 'audio-yes',
        capabilities: ['audio'],
        defaultModels: { audio: 'a-1' },
      },
    ]);

    const catalog = parseInferAudioProviders(stdout);

    expect(catalog.providers.map((p) => p.id)).toEqual(['audio-yes']);
  });

  it('tolerates missing defaultModels.audio with empty models', () => {
    const stdout = JSON.stringify([
      {
        available: true,
        configured: true,
        id: 'xai',
        capabilities: ['audio'],
      },
    ]);

    const catalog = parseInferAudioProviders(stdout);
    expect(catalog.providers[0]?.models).toEqual([]);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseInferAudioProviders('not json')).toThrow(
      /Invalid OpenClaw infer audio providers JSON/i,
    );
  });

  it('rejects non-array payloads and missing provider ids', () => {
    expect(() => parseInferAudioProviders(JSON.stringify({ providers: [] }))).toThrow(
      /audio providers output must be an array/i,
    );
    expect(() =>
      parseInferAudioProviders(JSON.stringify([{ capabilities: ['audio'] }])),
    ).toThrow(/audio provider missing id/i);
  });
});

describe('getSttCatalogWithOpenClawInfer', () => {
  it('calls the audio providers command and returns the normalized catalog', async () => {
    const calls: Array<{ command: string; args: string[]; signal?: AbortSignal }> = [];

    const catalog = await getSttCatalogWithOpenClawInfer({
      exec: async (request) => {
        calls.push(request);
        return {
          stdout: JSON.stringify([
            {
              available: true,
              configured: true,
              selected: true,
              id: 'xai',
              capabilities: ['audio'],
              defaultModels: { audio: 'grok-stt' },
            },
          ]),
          stderr: '',
        };
      },
    });

    expect(calls).toEqual([{ ...buildInferAudioProvidersCommand() }]);
    expect(catalog.activeProvider).toBe('xai');
    expect(catalog.providers[0]?.models).toEqual(['grok-stt']);
  });

  it('maps exec failures to a stable STT catalog error code', async () => {
    const failure = Object.assign(new Error('process failed'), { stderr: 'provider exploded' });

    await expect(
      getSttCatalogWithOpenClawInfer({
        exec: async () => {
          throw failure;
        },
      }),
    ).rejects.toMatchObject({
      code: 'openclaw_infer_stt_catalog_failed',
      message: expect.stringContaining('openclaw_infer_stt_catalog_failed'),
    });
  });
});
