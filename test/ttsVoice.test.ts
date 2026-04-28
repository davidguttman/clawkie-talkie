// Pins that the daemon TTS session forwards only OpenClaw-supported
// voice hints onto the infer TTS command, and that VoiceSession captures
// voice settings from rendezvous + settings.update so the next TTS turn
// can use them when supported.

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
  it('passes a supported OpenClaw voice id to the infer command', async () => {
    const { buildInferTtsCommand } = await import('../daemon/src/openclawInfer');

    expect(
      buildInferTtsCommand({ text: 'hello there', outputPath: '/tmp/reply.mp3', voice: 'nova' }),
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
        '--local',
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
        '--local',
      ],
    });
  });

  it('uses provider defaults instead of forwarding legacy xAI voice ids', async () => {
    const { buildInferTtsCommand } = await import('../daemon/src/openclawInfer');

    expect(
      buildInferTtsCommand({ text: 'hello there', outputPath: '/tmp/reply.mp3', voice: 'eve' }),
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
        '--local',
      ],
    });
  });
});

describe('voice session voice settings', () => {
  it('applies voice settings from settings.update', async () => {
    const { VoiceSession } = await import('../daemon/src/voiceSession');
    const session = new VoiceSession({
      apiKey: 'test-key',
      signalServer: 'https://signal.example',
      iceServers: [],
      hostPeerId: 'host-1',
      roomId: 'host-1:session-1',
      sessionId: 'session-1',
      onClose: vi.fn(),
    });

    session.applyVoiceSettings({ voice: 'rex' });

    expect(session.currentTtsVoice).toBe('rex');
  });
});
