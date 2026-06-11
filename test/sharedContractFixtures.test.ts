import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_WANTED_PROTOCOL_FEATURES,
  DAEMON_SUPPORTED_PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  daemonToPhone,
  phoneToDaemon,
  type VoiceSettings,
} from '../client/src/voice/protocol';
import {
  reduce,
  type DrivingContext,
  type DrivingEvent,
  type DrivingSideEffect,
} from '../client/src/voice/drivingReducer';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function readFixture<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as T;
}

interface ProtocolFixture {
  messages: Record<string, unknown>;
}

interface ReducerScenario {
  name: string;
  initial: DrivingContext;
  events: DrivingEvent[];
  expected: DrivingContext;
  sideEffects: DrivingSideEffect['kind'][];
}

describe('shared protocol contract fixture', () => {
  const fixture = readFixture<ProtocolFixture>('shared/contract/protocol-messages.json');

  it('pins protocol version and features used by web and Android', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(phoneToDaemon.clientHello()).toEqual(fixture.messages.clientHello);
    expect(daemonToPhone.daemonHello()).toEqual(fixture.messages.daemonHello);
    expect(CLIENT_WANTED_PROTOCOL_FEATURES).toEqual(DAEMON_SUPPORTED_PROTOCOL_FEATURES);
  });

  it('builds the same rendezvous and new-session messages as Android', () => {
    const settings: VoiceSettings = {
      voice: 'nova',
      tts: { providerId: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
      stt: { providerId: 'openai', model: 'gpt-4o-mini-transcribe' },
    };

    expect(phoneToDaemon.rendezvousJoin({
      sessionId: 'session-fixture-123',
      sessionKey: 'agent:fixture:discord:channel:fixture-channel',
      channel: 'discord',
      target: 'channel:fixture-channel',
      accountId: 'fixture-account',
      settings,
    })).toEqual(fixture.messages.rendezvousJoin);

    expect(phoneToDaemon.sessionsCreateRequest({
      requestId: 'req-fixture-android-web-1',
      providerId: 'discord',
      agent: 'kamaji',
      target: 'channel:fixture-channel',
      accountId: 'fixture-account',
    })).toEqual(fixture.messages.sessionsCreateRequest);

    expect(daemonToPhone.ttsStart(24000, {
      buffered: true,
      turnId: 42,
      text: "Sure — I'm on it.",
    })).toEqual(fixture.messages.ttsStartBuffered);
  });
});

describe('shared Driving reducer contract fixture', () => {
  const fixture = readFixture<{ scenarios: ReducerScenario[] }>('shared/contract/driving-reducer.json');

  for (const scenario of fixture.scenarios) {
    it(scenario.name, () => {
      let ctx = scenario.initial;
      const sideEffects: DrivingSideEffect['kind'][] = [];
      for (const event of scenario.events) {
        const reduced = reduce(ctx, event);
        ctx = reduced.next;
        sideEffects.push(...reduced.side.map((item) => item.kind));
      }

      expect(ctx).toEqual(scenario.expected);
      expect(sideEffects).toEqual(scenario.sideEffects);
    });
  }
});
