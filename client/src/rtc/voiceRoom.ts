// Mirror of `daemon/src/voiceRoom.ts`. Both files must produce the
// same `roomId` for the same inputs — the browser uses this to know
// which room the daemon will host for the rendezvous handoff.

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
