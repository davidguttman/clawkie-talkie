// Derives a deterministic voice room id from the daemon host id and the
// OpenClaw session id. Mirror of `client/src/rtc/voiceRoom.ts`; the
// `voiceRoom.test.ts` pins both copies to the same output so the
// browser and daemon always derive the same room without needing any
// shared state.

export interface VoiceRoomInput {
  hostPeerId: string;
  sessionId: string;
}

export function makeVoiceRoomId(input: VoiceRoomInput): string {
  return `${input.hostPeerId}:${safeRoomSegment(input.sessionId)}`;
}

export function safeRoomSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160);
}
