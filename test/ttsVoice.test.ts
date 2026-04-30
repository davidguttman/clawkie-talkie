// Pins that the daemon TTS session forwards selected provider/model/voice
// hints onto the infer TTS command, and that VoiceSession captures voice
// settings from rendezvous + settings.update so the next TTS turn can use
// the selected provider/model/voice.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../daemon/src/signal.js', () => ({
  SignalClient: class SignalClient {
    on() {
      return this;
    }

    subscribe() {}
    close() {}
    sendSignal = vi.fn(async () => {});
  },
}));

describe('OpenClaw infer TTS voice forwarding', () => {
  it('passes the selected model and voice id to the infer command', async () => {
    const { buildInferTtsCommand } = await import('../daemon/src/openclawInfer');

    expect(
      buildInferTtsCommand({
        text: 'hello there',
        outputPath: '/tmp/reply.mp3',
        voice: 'nova',
        model: 'openai/gpt-4o-mini-tts',
      }),
    ).toEqual({
      command: 'openclaw',
      args: [
        'infer',
        'tts',
        'convert',
        '--text',
        'hello there',
        '--output',
        '/tmp/reply.mp3',
        '--json',
        '--model',
        'openai/gpt-4o-mini-tts',
        '--voice',
        'nova',
      ],
    });
  });

  it('uses provider defaults when no voice is configured', async () => {
    const { buildInferTtsCommand } = await import('../daemon/src/openclawInfer');

    expect(buildInferTtsCommand({ text: 'hello there', outputPath: '/tmp/reply.mp3' })).toEqual({
      command: 'openclaw',
      args: [
        'infer',
        'tts',
        'convert',
        '--text',
        'hello there',
        '--output',
        '/tmp/reply.mp3',
        '--json',
      ],
    });
  });

  it('forwards non-OpenAI voice ids and lets the selected provider validate support', async () => {
    const { buildInferTtsCommand } = await import('../daemon/src/openclawInfer');

    expect(
      buildInferTtsCommand({
        text: 'hello',
        outputPath: '/tmp/a.mp3',
        voice: 'eve',
        model: 'xai/some-model',
      }).args,
    ).toEqual(expect.arrayContaining(['--model', 'xai/some-model', '--voice', 'eve']));
  });

  it('omits --model when a voice-based provider has no model and only forwards --voice', async () => {
    const { buildInferTtsCommand } = await import('../daemon/src/openclawInfer');
    const command = buildInferTtsCommand({
      text: 'hello',
      outputPath: '/tmp/a.mp3',
      voice: 'eve',
    });

    expect(command.args).not.toContain('--model');
    expect(command.args).toEqual(expect.arrayContaining(['--voice', 'eve']));
  });
});

describe('buildTtsSessionRequest', () => {
  it('forwards provider+model+voice for traditional providers', async () => {
    const { buildTtsSessionRequest } = await import('../daemon/src/voiceSession');

    expect(
      buildTtsSessionRequest('hello', {
        providerId: 'openai',
        model: 'gpt-4o-mini-tts',
        voice: 'nova',
      }),
    ).toEqual({ text: 'hello', model: 'openai/gpt-4o-mini-tts', voice: 'nova' });
  });

  it('forwards provider+voice without a model for voice-based providers like xAI', async () => {
    const { buildTtsSessionRequest } = await import('../daemon/src/voiceSession');

    const request = buildTtsSessionRequest('hello', { providerId: 'xai', voice: 'eve' });

    expect(request).toEqual({ text: 'hello', voice: 'eve' });
    expect(request).not.toHaveProperty('model');
  });

  it('does not forward a legacy voice when no provider is selected', async () => {
    const { buildTtsSessionRequest } = await import('../daemon/src/voiceSession');

    expect(buildTtsSessionRequest('hello', { voice: 'rex' })).toEqual({ text: 'hello' });
  });
});

describe('voice session voice settings', () => {
  it('stores the full TTS selection from settings.update', async () => {
    const { VoiceSession } = await import('../daemon/src/voiceSession');
    const session = new VoiceSession({
      signalServer: 'https://signal.example',
      iceServers: [],
      hostPeerId: 'host-1',
      roomId: 'host-1:session-1',
      sessionId: 'session-1',
      onClose: vi.fn(),
    });

    session.applyVoiceSettings({
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
    });

    expect(
      (session as unknown as { currentTtsSelection: unknown }).currentTtsSelection,
    ).toEqual({ providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' });
  });

  it('keeps legacy voice settings without setting a model', async () => {
    const { VoiceSession } = await import('../daemon/src/voiceSession');
    const session = new VoiceSession({
      signalServer: 'https://signal.example',
      iceServers: [],
      hostPeerId: 'host-1',
      roomId: 'host-1:session-1',
      sessionId: 'session-1',
      onClose: vi.fn(),
    });

    session.applyVoiceSettings({ voice: 'rex' });

    expect(
      (session as unknown as { currentTtsSelection: unknown }).currentTtsSelection,
    ).toEqual({ voice: 'rex' });
    expect(session.currentTtsVoice).toBe('rex');
  });

  it('ignores malformed TTS fields and falls back to the legacy voice setting', async () => {
    const { VoiceSession } = await import('../daemon/src/voiceSession');
    const session = new VoiceSession({
      signalServer: 'https://signal.example',
      iceServers: [],
      hostPeerId: 'host-1',
      roomId: 'host-1:session-1',
      sessionId: 'session-1',
      onClose: vi.fn(),
    });

    expect(() => {
      session.applyVoiceSettings({
        tts: { providerId: 123, model: ['bad'], voice: 456 },
        voice: ' rex ',
      } as unknown as Parameters<typeof session.applyVoiceSettings>[0]);
    }).not.toThrow();

    expect(
      (session as unknown as { currentTtsSelection: unknown }).currentTtsSelection,
    ).toEqual({ voice: 'rex' });
    expect(session.currentTtsVoice).toBe('rex');
  });
});
