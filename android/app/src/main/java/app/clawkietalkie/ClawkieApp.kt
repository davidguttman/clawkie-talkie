package app.clawkietalkie

import android.app.Application
import android.media.AudioAttributes
import app.clawkietalkie.storage.Storage
import app.clawkietalkie.voice.HoldMusic
import app.clawkietalkie.voice.ReplaySpeech
import org.webrtc.PeerConnectionFactory
import org.webrtc.audio.JavaAudioDeviceModule

class ClawkieApp : Application() {
    lateinit var storage: Storage
        private set
    lateinit var peerConnectionFactory: PeerConnectionFactory
        private set

    override fun onCreate() {
        super.onCreate()
        storage = Storage(this)

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(this)
                .createInitializationOptions(),
        )
        // Route the daemon's TTS audio track through media (speaker) volume,
        // matching the web client's hidden media-element playback. We never
        // send a WebRTC audio track (mic PCM goes over the data channel), so
        // recording stays disabled.
        val audioDeviceModule = JavaAudioDeviceModule.builder(this)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .createAudioDeviceModule()
        peerConnectionFactory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioDeviceModule)
            .createPeerConnectionFactory()

        HoldMusic.init(this, storage)
        ReplaySpeech.init(this)
    }
}
