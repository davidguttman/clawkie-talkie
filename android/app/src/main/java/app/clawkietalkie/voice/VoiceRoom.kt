package app.clawkietalkie.voice

// Mirror of the daemon/web `voiceRoom.ts`. All copies must produce the same
// `roomId` for the same inputs — the phone uses this to know which room the
// daemon will host for the rendezvous handoff.

fun makeVoiceRoomId(hostPeerId: String, sessionId: String): String =
    "$hostPeerId:${safeRoomSegment(sessionId)}"

fun safeRoomSegment(value: String): String =
    value
        .trim()
        .replace(Regex("[^a-zA-Z0-9_-]+"), "_")
        .trim('_')
        .take(160)
