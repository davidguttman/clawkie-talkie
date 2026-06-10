package app.clawkietalkie.ui.driving

// Error-code → display label mapping. Mirror of `errorLabelFor` in the web
// client's Driving.tsx.
fun errorLabelFor(code: String): String = when {
    code == "daemon_not_connected" -> "DAEMON NOT CONNECTED"
    code == "mic_denied" -> "MIC PERMISSION DENIED"
    code == "empty_transcript" -> "NO SPEECH DETECTED — TRY AGAIN"
    code == "empty_audio" -> "NO AUDIO CAPTURED — TRY AGAIN"
    code == "media_recorder_unsupported" -> "AUDIO CAPTURE UNSUPPORTED ON THIS DEVICE"
    code == "audio_unsupported" -> "AUDIO PLAYBACK UNSUPPORTED ON THIS DEVICE"
    code == "openclaw_infer_stt_failed" -> "INFER ERROR · OPENCLAW INFER STT FAILED"
    // TTS failures arrive after the reply text was already generated and
    // saved to the thread; frame as a non-fatal audio-only problem.
    code.startsWith("openclaw_infer_tts_failed") -> "AUDIO UNAVAILABLE · REPLY IS IN THE THREAD"
    code == "openclaw_auth_unavailable" -> "REPLY ERROR · OPENCLAW AUTH UNAVAILABLE"
    code.startsWith("xai_http_") -> "DAEMON · XAI " + code.removePrefix("xai_http_").let { "HTTP $it" }
    code == "xai_empty_reply" -> "DAEMON · XAI EMPTY REPLY"
    else -> "VOICE ERROR · $code"
}
