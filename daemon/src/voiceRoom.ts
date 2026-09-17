// Derives a deterministic voice room id from the daemon host id and the
// OpenClaw session id. Mirror of `client/src/rtc/voiceRoom.ts`; the
// `voiceRoom.test.ts` pins both copies to the same output so the
// browser and daemon always derive the same room without needing any
// shared state.
//
// `deviceId` is an optional per-client lane. Without it, every client
// joining the same session lands in ONE room whose single peer slot is
// newest-wins — the Pi and the web client kicked each other off (2026-09-17).
// With it, each device gets its own room for the session and they coexist;
// reconnects of the SAME device still reuse their lane and keep the
// replace-on-reconnect semantics. Old clients that omit deviceId keep the
// legacy shared-room behavior.

export interface VoiceRoomInput {
  hostPeerId: string;
  sessionId: string;
  deviceId?: string;
}

export function makeVoiceRoomId(input: VoiceRoomInput): string {
  const base = `${input.hostPeerId}:${safeRoomSegment(input.sessionId)}`;
  return input.deviceId ? `${base}~${safeRoomSegment(input.deviceId)}` : base;
}

export function safeRoomSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160);
}
