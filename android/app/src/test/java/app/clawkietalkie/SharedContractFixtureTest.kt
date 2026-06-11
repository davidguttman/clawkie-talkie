package app.clawkietalkie

import app.clawkietalkie.protocol.CLIENT_WANTED_PROTOCOL_FEATURES
import app.clawkietalkie.protocol.ControlMessage
import app.clawkietalkie.protocol.NewSessionCreateInput
import app.clawkietalkie.protocol.PROTOCOL_VERSION
import app.clawkietalkie.protocol.PhoneToDaemon
import app.clawkietalkie.protocol.RendezvousJoinInput
import app.clawkietalkie.protocol.SttSelection
import app.clawkietalkie.protocol.TtsSelection
import app.clawkietalkie.protocol.VoiceSettings
import app.clawkietalkie.voice.DrivingContext
import app.clawkietalkie.voice.DrivingEvent
import app.clawkietalkie.voice.DrivingSideEffect
import app.clawkietalkie.voice.DrivingState
import app.clawkietalkie.voice.reduce
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedContractFixtureTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun `protocol builders match shared web Android fixture`() {
        val messages = fixture("protocol-messages.json")
            .jsonObject["messages"]!!.jsonObject

        assertEquals(1, PROTOCOL_VERSION)
        assertEquals(messages["clientHello"]!!.jsonObject, parseObject(PhoneToDaemon.clientHello().encode()))
        assertEquals(
            listOf(
                "tts.catalog",
                "stt.catalog",
                "sessions.list",
                "sessions.catalog",
                "sessions.destinations",
                "sessions.create",
            ),
            CLIENT_WANTED_PROTOCOL_FEATURES,
        )

        assertEquals(
            messages["rendezvousJoin"]!!.jsonObject,
            parseObject(
                PhoneToDaemon.rendezvousJoin(
                    RendezvousJoinInput(
                        sessionId = "session-fixture-123",
                        sessionKey = "agent:fixture:discord:channel:fixture-channel",
                        channel = "discord",
                        target = "channel:fixture-channel",
                        accountId = "fixture-account",
                    ),
                    VoiceSettings(
                        voice = "nova",
                        tts = TtsSelection(
                            providerId = "openai",
                            model = "gpt-4o-mini-tts",
                            voice = "nova",
                        ),
                        stt = SttSelection(
                            providerId = "openai",
                            model = "gpt-4o-mini-transcribe",
                        ),
                    ),
                ).encode(),
            ),
        )

        assertEquals(
            messages["sessionsCreateRequest"]!!.jsonObject,
            parseObject(
                PhoneToDaemon.sessionsCreateRequest(
                    NewSessionCreateInput(
                        requestId = "req-fixture-android-web-1",
                        providerId = "discord",
                        agent = "kamaji",
                        target = "channel:fixture-channel",
                        accountId = "fixture-account",
                    ),
                ).encode(),
            ),
        )

        val ttsStart = ControlMessage(messages["ttsStartBuffered"]!!.jsonObject)
        assertEquals("tts.start", ttsStart.t)
        assertEquals(24000, ttsStart.int("sample_rate"))
        assertEquals(true, ttsStart.boolean("buffered"))
        assertEquals(42, ttsStart.int("turnId"))
        assertEquals("Sure — I'm on it.", ttsStart.string("text"))
    }

    @Test
    fun `driving reducer matches shared web Android fixture`() {
        val scenarios = fixture("driving-reducer.json")
            .jsonObject["scenarios"]!!.jsonArray

        assertTrue("fixture should include meaningful reducer scenarios", scenarios.size >= 3)

        for (scenarioElement in scenarios) {
            val scenario = scenarioElement.jsonObject
            val name = scenario.string("name")
            var ctx = scenario.context("initial")
            val sideEffects = mutableListOf<String>()

            for (eventElement in scenario["events"]!!.jsonArray) {
                val reduced = reduce(ctx, eventElement.jsonObject.toDrivingEvent())
                ctx = reduced.next
                sideEffects.addAll(reduced.side.map { it.fixtureName })
            }

            assertEquals(name, scenario.context("expected"), ctx)
            assertEquals(name, scenario["sideEffects"]!!.jsonArray.map { it.jsonPrimitive.content }, sideEffects)
        }
    }

    private fun fixture(resourcePath: String): JsonElement {
        val stream = javaClass.classLoader?.getResourceAsStream(resourcePath)
            ?: error("Could not find fixture resource $resourcePath on the test classpath")
        return stream.bufferedReader().use { reader ->
            json.parseToJsonElement(reader.readText())
        }
    }

    private fun parseObject(text: String): JsonObject = json.parseToJsonElement(text).jsonObject

    private fun JsonObject.string(key: String): String = this[key]!!.jsonPrimitive.content

    private fun JsonObject.nullableString(key: String): String? {
        val value = this[key] ?: return null
        if (value !is JsonPrimitive) return null
        if (!value.isString && value.content == "null") return null
        return if (value.isString) value.content else null
    }

    private fun JsonObject.context(key: String): DrivingContext {
        val source = this[key]!!.jsonObject
        return DrivingContext(
            state = when (source.string("state")) {
                "idle" -> DrivingState.IDLE
                "recording" -> DrivingState.RECORDING
                "thinking" -> DrivingState.THINKING
                "ai" -> DrivingState.AI
                else -> error("Unknown state ${source.string("state")}")
            },
            lastUserText = source.string("lastUserText"),
            lastReplyText = source.string("lastReplyText"),
            pendingReplyText = source.string("pendingReplyText"),
            liveReplyText = source.string("liveReplyText"),
            error = source.nullableString("error"),
        )
    }

    private fun JsonObject.toDrivingEvent(): DrivingEvent = when (string("type")) {
        "tap" -> DrivingEvent.Tap(currentTurnTranscribing = boolean("currentTurnTranscribing") ?: false)
        "silence" -> DrivingEvent.Silence
        "stt.done" -> DrivingEvent.SttDone(string("text"))
        "stt.error" -> DrivingEvent.SttError(string("reason"))
        "reply.done" -> DrivingEvent.ReplyDone(string("text"))
        "reply.error" -> DrivingEvent.ReplyError(string("reason"))
        "tts.start" -> DrivingEvent.TtsStart(nullableString("text"))
        "tts.done" -> DrivingEvent.TtsDone
        "tts.error" -> DrivingEvent.TtsError(string("reason"))
        else -> error("Unknown reducer event ${string("type")}")
    }

    private fun JsonObject.boolean(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull

    private val DrivingSideEffect.fixtureName: String
        get() = when (this) {
            DrivingSideEffect.START_MIC -> "startMic"
            DrivingSideEffect.STOP_MIC -> "stopMic"
            DrivingSideEffect.CANCEL_MIC -> "cancelMic"
            DrivingSideEffect.ARM_TTS -> "armTts"
            DrivingSideEffect.STOP_TTS -> "stopTts"
            DrivingSideEffect.CANCEL_REPLY -> "cancelReply"
        }
}
