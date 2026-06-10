package app.clawkietalkie

import app.clawkietalkie.voice.CurrentTurnTranscript
import app.clawkietalkie.voice.DrivingContext
import app.clawkietalkie.voice.DrivingEvent
import app.clawkietalkie.voice.DrivingSideEffect
import app.clawkietalkie.voice.DrivingState
import app.clawkietalkie.voice.composeTranscript
import app.clawkietalkie.voice.displayedCaptionText
import app.clawkietalkie.voice.initialDrivingContext
import app.clawkietalkie.voice.isCurrentTurnTranscribing
import app.clawkietalkie.voice.reduce
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Port of test/drivingReducer.test.ts — pure-function tests for the Driving
// state machine.

class DrivingReducerTest {
    private val idle = initialDrivingContext
    private val recording = initialDrivingContext.copy(state = DrivingState.RECORDING)
    private val thinking = initialDrivingContext.copy(state = DrivingState.THINKING, lastUserText = "hello")
    private val ai = initialDrivingContext.copy(
        state = DrivingState.AI,
        lastUserText = "hello",
        lastReplyText = "hi there",
        liveReplyText = "hi there",
    )

    @Test
    fun `idle tap moves to recording and arms the mic`() {
        val (next, side) = reduce(idle, DrivingEvent.Tap())
        assertEquals(DrivingState.RECORDING, next.state)
        assertNull(next.error)
        assertEquals(listOf(DrivingSideEffect.START_MIC), side)
    }

    @Test
    fun `idle buffered ttsStart without text enters ai so playback can be silenced`() {
        val started = reduce(idle, DrivingEvent.TtsStart())
        assertEquals(DrivingState.AI, started.next.state)
        assertEquals("", started.next.lastReplyText)
        assertEquals("", started.next.liveReplyText)
        assertTrue(started.side.isEmpty())

        val silenced = reduce(started.next, DrivingEvent.Silence)
        assertEquals(DrivingState.IDLE, silenced.next.state)
        assertEquals(listOf(DrivingSideEffect.STOP_TTS), silenced.side)
    }

    @Test
    fun `idle ignores unrelated events`() {
        assertEquals(DrivingState.IDLE, reduce(idle, DrivingEvent.Silence).next.state)
        assertEquals(DrivingState.IDLE, reduce(idle, DrivingEvent.SttDone("x")).next.state)
        assertEquals(DrivingState.IDLE, reduce(idle, DrivingEvent.TtsDone).next.state)
    }

    @Test
    fun `recording tap stops the mic and enters thinking`() {
        val (next, side) = reduce(recording, DrivingEvent.Tap())
        assertEquals(DrivingState.THINKING, next.state)
        assertEquals(listOf(DrivingSideEffect.STOP_MIC), side)
    }

    @Test
    fun `recording sttError cancels back to idle with the reason surfaced`() {
        val (next, side) = reduce(recording, DrivingEvent.SttError("mic_denied"))
        assertEquals(DrivingState.IDLE, next.state)
        assertEquals("mic_denied", next.error)
        assertEquals(listOf(DrivingSideEffect.CANCEL_MIC), side)
    }

    @Test
    fun `thinking replyDone stays thinking hides reply text and arms tts`() {
        val (next, side) = reduce(thinking, DrivingEvent.ReplyDone("sup"))
        assertEquals(DrivingState.THINKING, next.state)
        assertEquals("sup", next.pendingReplyText)
        assertEquals("", next.lastReplyText)
        assertEquals("", next.liveReplyText)
        assertEquals(listOf(DrivingSideEffect.ARM_TTS), side)
    }

    @Test
    fun `thinking ttsStart with pending reply reveals the response and enters ai`() {
        val (next, side) = reduce(
            thinking.copy(pendingReplyText = "sup", lastReplyText = "previous audible reply"),
            DrivingEvent.TtsStart(),
        )
        assertEquals(DrivingState.AI, next.state)
        assertEquals("", next.pendingReplyText)
        assertEquals("sup", next.lastReplyText)
        assertEquals("sup", next.liveReplyText)
        assertTrue(side.isEmpty())
    }

    @Test
    fun `thinking stale ttsStart without pending reply does not show previous turn text`() {
        val (next, side) = reduce(
            thinking.copy(pendingReplyText = "", lastReplyText = "previous audible reply", liveReplyText = ""),
            DrivingEvent.TtsStart(),
        )
        assertEquals(DrivingState.THINKING, next.state)
        assertEquals("", next.pendingReplyText)
        assertEquals("previous audible reply", next.lastReplyText)
        assertEquals("", next.liveReplyText)
        assertTrue(side.isEmpty())
    }

    @Test
    fun `thinking replyDone then ttsError preserves the reply as the last ai turn`() {
        val ctx = reduce(thinking, DrivingEvent.ReplyDone("unheard reply")).next
        val (next, side) = reduce(
            ctx,
            DrivingEvent.TtsError("openclaw_infer_tts_failed: fetch timeout after 30000ms"),
        )
        assertEquals(DrivingState.IDLE, next.state)
        assertEquals("openclaw_infer_tts_failed: fetch timeout after 30000ms", next.error)
        assertEquals("", next.pendingReplyText)
        assertEquals("unheard reply", next.lastReplyText)
        assertEquals("", next.liveReplyText)
        assertTrue(side.isEmpty())
    }

    @Test
    fun `thinking replyDone then ttsDone returns idle without exposing the pending reply`() {
        val ctx = reduce(thinking, DrivingEvent.ReplyDone("unheard reply")).next
        val (next, side) = reduce(ctx, DrivingEvent.TtsDone)
        assertEquals(DrivingState.IDLE, next.state)
        assertEquals("", next.pendingReplyText)
        assertTrue(side.isEmpty())
    }

    @Test
    fun `thinking replyError returns idle with the reason`() {
        val (next, _) = reduce(thinking, DrivingEvent.ReplyError("openclaw_failed"))
        assertEquals(DrivingState.IDLE, next.state)
        assertEquals("openclaw_failed", next.error)
    }

    @Test
    fun `thinking sttDone records the final transcript`() {
        val (next, side) = reduce(thinking, DrivingEvent.SttDone("final words"))
        assertEquals(DrivingState.THINKING, next.state)
        assertEquals("final words", next.lastUserText)
        assertTrue(side.isEmpty())
    }

    @Test
    fun `thinking tap while transcribing is ignored`() {
        val (next, side) = reduce(thinking, DrivingEvent.Tap(currentTurnTranscribing = true))
        assertEquals(DrivingState.THINKING, next.state)
        assertTrue(side.isEmpty())
    }

    @Test
    fun `thinking tap after transcription cancels the reply`() {
        val (next, side) = reduce(thinking, DrivingEvent.Tap(currentTurnTranscribing = false))
        assertEquals(DrivingState.IDLE, next.state)
        assertEquals(listOf(DrivingSideEffect.CANCEL_REPLY), side)
    }

    @Test
    fun `ai tap silences playback`() {
        val (next, side) = reduce(ai, DrivingEvent.Tap())
        assertEquals(DrivingState.IDLE, next.state)
        assertEquals(listOf(DrivingSideEffect.STOP_TTS), side)
    }

    @Test
    fun `ai ttsDone completes the turn`() {
        val (next, side) = reduce(ai, DrivingEvent.TtsDone)
        assertEquals(DrivingState.IDLE, next.state)
        assertTrue(side.isEmpty())
        assertEquals("hi there", next.lastReplyText)
    }

    @Test
    fun `ai ttsError surfaces the reason and clears live text`() {
        val (next, _) = reduce(ai, DrivingEvent.TtsError("audio_unsupported"))
        assertEquals(DrivingState.IDLE, next.state)
        assertEquals("audio_unsupported", next.error)
        assertEquals("", next.liveReplyText)
    }

    @Test
    fun `session reset returns to the initial context`() {
        val (next, side) = reduce(ai, DrivingEvent.SessionReset)
        assertEquals(initialDrivingContext, next)
        assertTrue(side.isEmpty())
    }

    @Test
    fun `session replay runs events in order`() {
        val replay = DrivingEvent.SessionReplay(
            events = listOf(
                DrivingEvent.SttDone("question"),
                DrivingEvent.ReplyDone("answer"),
                DrivingEvent.TtsStart(),
            ),
        )
        val (next, side) = reduce(thinking, replay)
        assertEquals(DrivingState.AI, next.state)
        assertEquals("answer", next.lastReplyText)
        assertTrue(DrivingSideEffect.ARM_TTS in side)
    }

    @Test
    fun `terminal replay events win over a non-idle hydration`() {
        val replay = DrivingEvent.SessionReplay(
            events = listOf(
                DrivingEvent.SttDone("question"),
                DrivingEvent.ReplyDone("answer"),
                DrivingEvent.TtsStart(),
                DrivingEvent.TtsDone,
            ),
            hydration = app.clawkietalkie.voice.DrivingHydration(
                context = initialDrivingContext.copy(
                    state = DrivingState.AI,
                    lastReplyText = "answer",
                    liveReplyText = "answer",
                ),
                armTts = true,
            ),
        )
        val (next, side) = reduce(thinking, replay)
        assertEquals(DrivingState.IDLE, next.state)
        assertEquals("", next.pendingReplyText)
        assertEquals("", next.liveReplyText)
        assertFalse(DrivingSideEffect.ARM_TTS in side)
    }

    // -- helper coverage (drivingLoop.ts exports) ------------------------

    @Test
    fun `displayedCaptionText prefers liveReplyText in ai state`() {
        val ctx = DrivingContext(state = DrivingState.AI, liveReplyText = "reply")
        assertEquals("reply", displayedCaptionText(ctx, "live"))
        assertEquals("live", displayedCaptionText(ctx.copy(state = DrivingState.RECORDING), "live"))
    }

    @Test
    fun `isCurrentTurnTranscribing only while thinking with an active transcript`() {
        assertTrue(
            isCurrentTurnTranscribing(
                DrivingState.THINKING,
                CurrentTurnTranscript(active = true, sttDone = false, text = "x"),
            ),
        )
        assertFalse(
            isCurrentTurnTranscribing(
                DrivingState.THINKING,
                CurrentTurnTranscript(active = true, sttDone = true, text = "x"),
            ),
        )
        assertFalse(
            isCurrentTurnTranscribing(
                DrivingState.RECORDING,
                CurrentTurnTranscript(active = true, sttDone = false, text = "x"),
            ),
        )
    }

    @Test
    fun `composeTranscript joins finals and current interim`() {
        assertEquals("a b c", composeTranscript(listOf("a", "b"), " c "))
        assertEquals("a b", composeTranscript(listOf("a", "b"), "  "))
        assertEquals("c", composeTranscript(emptyList(), "c"))
    }
}
