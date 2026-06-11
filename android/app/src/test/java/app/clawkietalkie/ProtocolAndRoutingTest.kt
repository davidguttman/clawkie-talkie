package app.clawkietalkie

import app.clawkietalkie.protocol.ControlMessage
import app.clawkietalkie.protocol.NewSessionCreateInput
import app.clawkietalkie.protocol.PhoneToDaemon
import app.clawkietalkie.protocol.RendezvousJoinInput
import app.clawkietalkie.protocol.decodeNewSessionDestinationsCatalog
import app.clawkietalkie.protocol.TtsSelection
import app.clawkietalkie.protocol.VoiceSettings
import app.clawkietalkie.rtc.ForwardDecision
import app.clawkietalkie.rtc.SdpRouteState
import app.clawkietalkie.rtc.SignalAction
import app.clawkietalkie.rtc.SignalKind
import app.clawkietalkie.rtc.classifySignal
import app.clawkietalkie.rtc.decideForwardToLivePeer
import app.clawkietalkie.rtc.decideIncomingSignal
import app.clawkietalkie.voice.makeVoiceRoomId
import app.clawkietalkie.voice.parseHandoffUrl
import app.clawkietalkie.voice.parseHostDashboardUrl
import app.clawkietalkie.voice.parseSttChunkMs
import app.clawkietalkie.voice.safeRoomSegment
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolAndRoutingTest {
    private val json = Json

    @Test
    fun `client hello carries protocol 1 and wanted features`() {
        val msg = json.parseToJsonElement(PhoneToDaemon.clientHello().encode()).jsonObject
        assertEquals("client.hello", msg["t"]!!.jsonPrimitive.content)
        assertEquals(1, msg["protocol"]!!.jsonPrimitive.content.toInt())
        val wants = msg["wants"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertEquals(
            listOf(
                "tts.catalog",
                "stt.catalog",
                "sessions.list",
                "sessions.catalog",
                "sessions.destinations",
                "sessions.create",
            ),
            wants,
        )
    }


    @Test
    fun `new session destination and create protocol mirrors web shape`() {
        val destinations = json.parseToJsonElement(PhoneToDaemon.sessionsDestinationsRequest().encode()).jsonObject
        assertEquals("sessions.destinations.request", destinations["t"]!!.jsonPrimitive.content)

        val create = json.parseToJsonElement(
            PhoneToDaemon.sessionsCreateRequest(
                NewSessionCreateInput(
                    requestId = "req-1",
                    providerId = "discord",
                    target = "channel:100",
                    accountId = "acct-a",
                ),
            ).encode(),
        ).jsonObject
        assertEquals("sessions.create.request", create["t"]!!.jsonPrimitive.content)
        assertEquals("req-1", create["requestId"]!!.jsonPrimitive.content)
        assertEquals("discord", create["providerId"]!!.jsonPrimitive.content)
        assertEquals("channel:100", create["target"]!!.jsonPrimitive.content)
        assertEquals("acct-a", create["accountId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `new session destination catalog decoder keeps web local option and real channel destinations`() {
        val catalog = decodeNewSessionDestinationsCatalog(
            json.parseToJsonElement(
                """{
                  "generatedAt":"2026-06-10T00:00:00.000Z",
                  "providers":[
                    {"id":"webchat","label":"Web only (no chat channel)","kind":"local","status":"available","destinations":[]},
                    {"id":"discord","label":"Discord","kind":"channel","status":"available","destinations":[
                      {"id":"discord:channel:100","target":"channel:100","label":"#general","group":"Claw HQ","accountId":"acct-a"}
                    ]}
                  ]
                }""".trimIndent(),
            ).jsonObject,
        )
        assertEquals("2026-06-10T00:00:00.000Z", catalog.generatedAt)
        assertEquals(listOf("webchat", "discord"), catalog.providers.map { it.id })
        assertEquals("local", catalog.providers[0].kind)
        assertEquals("#general", catalog.providers[1].destinations[0].label)
        assertEquals("Claw HQ", catalog.providers[1].destinations[0].group)
        assertEquals("acct-a", catalog.providers[1].destinations[0].accountId)
    }

    @Test
    fun `rendezvous join includes only present routing fields`() {
        val full = json.parseToJsonElement(
            PhoneToDaemon.rendezvousJoin(
                RendezvousJoinInput(
                    sessionId = "session-1",
                    sessionKey = "agent:main:discord:channel:42",
                    channel = "discord",
                    target = "channel:42",
                    accountId = "acct",
                ),
                VoiceSettings(voice = "nova", tts = TtsSelection(providerId = "openai", voice = "nova")),
            ).encode(),
        ).jsonObject
        assertEquals("rendezvous.join", full["t"]!!.jsonPrimitive.content)
        assertEquals("session-1", full["sessionId"]!!.jsonPrimitive.content)
        assertEquals("agent:main:discord:channel:42", full["sessionKey"]!!.jsonPrimitive.content)
        assertEquals("discord", full["channel"]!!.jsonPrimitive.content)
        assertEquals("channel:42", full["target"]!!.jsonPrimitive.content)
        assertEquals("acct", full["accountId"]!!.jsonPrimitive.content)
        val settings = full["settings"]!!.jsonObject
        assertEquals("nova", settings["voice"]!!.jsonPrimitive.content)
        assertEquals("openai", settings["tts"]!!.jsonObject["providerId"]!!.jsonPrimitive.content)

        val minimal = json.parseToJsonElement(
            PhoneToDaemon.rendezvousJoin(RendezvousJoinInput(sessionId = "s"), null).encode(),
        ).jsonObject
        assertEquals(setOf("t", "sessionId"), minimal.keys)
    }

    @Test
    fun `control message parser tolerates unknown fields and non-objects`() {
        val msg = ControlMessage.parse("""{"t":"tts.start","sample_rate":24000,"buffered":true,"x":1}""")!!
        assertEquals("tts.start", msg.t)
        assertEquals(24000, msg.int("sample_rate"))
        assertEquals(true, msg.boolean("buffered"))
        assertNull(ControlMessage.parse("[1,2,3]"))
        assertNull(ControlMessage.parse("not json"))
    }

    @Test
    fun `voice room id mirrors daemon derivation`() {
        assertEquals("host:session-1", makeVoiceRoomId("host", "session-1"))
        assertEquals("host:a_b", makeVoiceRoomId("host", "  a b  "))
        assertEquals("abc_def", safeRoomSegment("abc!@#def"))
        assertEquals("x", safeRoomSegment("___x___"))
        assertEquals(160, safeRoomSegment("a".repeat(400)).length)
    }

    @Test
    fun `handoff urls parse hash-first with query fallback`() {
        val hashRoute = parseHandoffUrl(
            "https://clawkietalkie.app/voice#host=H&session=S&sessionKey=K&channel=discord&target=channel:1&accountId=A",
        )!!
        assertEquals("H", hashRoute.hostPeerId)
        assertEquals("S", hashRoute.sessionId)
        assertEquals("K", hashRoute.sessionKey)
        assertEquals("discord", hashRoute.channel)
        assertEquals("channel:1", hashRoute.target)
        assertEquals("A", hashRoute.accountId)

        val queryRoute = parseHandoffUrl("/voice?host=H&session=S")!!
        assertEquals("H", queryRoute.hostPeerId)
        assertEquals("S", queryRoute.sessionId)

        // Hash wins over query
        val both = parseHandoffUrl("/voice?host=Q&session=QS#host=H&session=S")!!
        assertEquals("H", both.hostPeerId)
        assertEquals("S", both.sessionId)

        assertNull(parseHandoffUrl("/voice#host=H"))
        assertNull(parseHandoffUrl("/dashboard#host=H&session=S"))
    }

    @Test
    fun `dashboard urls require host without session`() {
        assertEquals("H", parseHostDashboardUrl("https://clawkietalkie.app/dashboard#host=H")!!.hostPeerId)
        assertEquals("H", parseHostDashboardUrl("/voice#host=H")!!.hostPeerId)
        assertNull(parseHostDashboardUrl("/voice#host=H&session=S"))
        assertNull(parseHostDashboardUrl("/dashboard"))
    }

    @Test
    fun `signal classification mirrors simple-peer payload shapes`() {
        fun obj(raw: String): JsonObject = json.parseToJsonElement(raw).jsonObject
        assertEquals(SignalKind.OFFER, classifySignal(obj("""{"type":"offer","sdp":"x"}""")))
        assertEquals(SignalKind.ANSWER, classifySignal(obj("""{"type":"answer","sdp":"x"}""")))
        assertEquals(SignalKind.CANDIDATE, classifySignal(obj("""{"type":"candidate","candidate":{}}""")))
        assertEquals(SignalKind.CANDIDATE, classifySignal(obj("""{"candidate":{"candidate":"c"}}""")))
        assertEquals(SignalKind.RENEGOTIATE, classifySignal(obj("""{"renegotiate":true}""")))
        assertEquals(SignalKind.TRANSCEIVER, classifySignal(obj("""{"transceiverRequest":{}}""")))
        assertEquals(SignalKind.UNKNOWN, classifySignal(obj("""{"foo":1}""")))
    }

    @Test
    fun `incoming signal routing buffers candidates and creates on offer`() {
        assertEquals(
            SignalAction.CREATE_NON_INITIATOR,
            decideIncomingSignal(hasLivePeer = false, kind = SignalKind.OFFER),
        )
        assertEquals(
            SignalAction.BUFFER_CANDIDATE,
            decideIncomingSignal(hasLivePeer = false, kind = SignalKind.CANDIDATE),
        )
        assertEquals(
            SignalAction.IGNORE,
            decideIncomingSignal(hasLivePeer = false, kind = SignalKind.ANSWER),
        )
        assertEquals(
            SignalAction.FORWARD,
            decideIncomingSignal(hasLivePeer = true, kind = SignalKind.CANDIDATE),
        )
    }

    @Test
    fun `duplicate and role-invalid sdp is dropped on the forward path`() {
        val nonInitiator = SdpRouteState(initiator = false, acceptedOffer = true, acceptedAnswer = false)
        assertEquals(ForwardDecision.DROP_DUPLICATE_SDP, decideForwardToLivePeer(nonInitiator, SignalKind.OFFER))
        assertEquals(ForwardDecision.DROP_UNEXPECTED_SDP, decideForwardToLivePeer(nonInitiator, SignalKind.ANSWER))
        assertEquals(ForwardDecision.FORWARD, decideForwardToLivePeer(nonInitiator, SignalKind.CANDIDATE))
        val fresh = SdpRouteState(initiator = false, acceptedOffer = false, acceptedAnswer = false)
        assertEquals(ForwardDecision.FORWARD, decideForwardToLivePeer(fresh, SignalKind.OFFER))
    }

    @Test
    fun `stt chunk config parses only plain integers`() {
        val cfg = parseSttChunkMs("250")!!
        assertEquals(250, cfg.chunkMs)
        assertEquals(8000, cfg.chunkBytes)
        assertNull(parseSttChunkMs(null))
        assertNull(parseSttChunkMs("abc"))
        assertNull(parseSttChunkMs("-5"))
        assertTrue(parseSttChunkMs("0")!!.chunkBytes == 0)
    }
}

class FixtureWavTest {
    private fun wav(dataChunkSize: Long, pcm: ByteArray): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        out.write("RIFF".toByteArray()); out.write(ByteArray(4))
        out.write("WAVE".toByteArray())
        out.write("fmt ".toByteArray())
        out.write(byteArrayOf(16, 0, 0, 0)); out.write(ByteArray(16))
        out.write("data".toByteArray())
        for (shift in intArrayOf(0, 8, 16, 24)) {
            out.write(((dataChunkSize shr shift) and 0xff).toInt())
        }
        out.write(pcm)
        return out.toByteArray()
    }

    @Test
    fun `parses exact-size data chunks`() {
        val pcm = ByteArray(64) { it.toByte() }
        val parsed = app.clawkietalkie.voice.FixtureAudioSource.parseFixture(wav(64, pcm))
        assertTrue(parsed.contentEquals(pcm))
    }

    @Test
    fun `clamps streaming sentinel chunk sizes instead of overflowing`() {
        val pcm = ByteArray(64) { it.toByte() }
        // ffmpeg streaming WAVs declare 0x7FFFFFFF (or 0xFFFFFFFF) data size.
        for (sentinel in longArrayOf(0x7FFFFFFFL, 0xFFFFFFFFL)) {
            val parsed = app.clawkietalkie.voice.FixtureAudioSource.parseFixture(wav(sentinel, pcm))
            assertTrue(parsed.contentEquals(pcm))
        }
    }

    @Test
    fun `non-riff input is treated as raw pcm`() {
        val raw = ByteArray(32) { 7 }
        assertTrue(app.clawkietalkie.voice.FixtureAudioSource.parseFixture(raw).contentEquals(raw))
    }
}
