// Mirror of `daemon/src/voiceRoom.ts`. Both files must produce the
// same `roomId` for the same inputs — the browser uses this to know
// which room the daemon will host for the rendezvous handoff.
// `deviceId` adds an optional per-client lane so two devices sharing
// one session each get their own room instead of fighting over the
// session's single peer slot (2026-09-17).

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
