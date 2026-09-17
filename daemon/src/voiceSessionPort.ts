// Minimal port the push-audio channel needs from a voice session.
// Kept in its own module so pushAudio.ts has no import cycle with
// voiceSession.ts; VoiceSession satisfies this structurally.

import type { DaemonToPhone } from './protocol.js';

export interface VoiceSessionNotificationPort {
  /** True when no turn is in flight and no STT (mic) session is open. */
  isRoomQuiet(): boolean;
  /** True when a client data channel is connected and usable. */
  isConnected(): boolean;
  /** Connection-scoped control send (NOT recorded into catch-up history — notifications are ephemeral). */
  sendControl(msg: DaemonToPhone): boolean;
  /** Binary PCM frame send (same wire path as turn audio). */
  sendAudio(pcm: Uint8Array): boolean;
}