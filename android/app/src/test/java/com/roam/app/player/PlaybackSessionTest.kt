package com.roam.app.player

import com.roam.app.data.PlayManifest
import com.roam.app.data.PlaySegment
import com.roam.app.data.SceneSkip
import com.roam.app.data.SkipSegment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeEngine : PlayerEngine {
    var playing = true
    var paused = false
    var item = 0
    var position = 0.0
    val log = mutableListOf<String>()
    override val isPlaying get() = playing
    override val isPaused get() = paused
    override val itemIndex get() = item
    override val positionSeconds get() = position
    override fun seekInItem(seconds: Double) {
        log += "seek $seconds"
        position = seconds
    }
    override fun gotoItem(index: Int, seconds: Double) {
        log += "item $index $seconds"
        item = index
        position = seconds
    }
    override fun stop() {
        log += "stop"
        playing = false
    }
    override fun setMuted(muted: Boolean) {
        log += "mute $muted"
    }
}

private class RecordingReporter : Reporter {
    val saves = mutableListOf<Triple<Int, Int, Boolean>>()
    var beats = 0
    var ended = 0
    var lose: String? = null
    override fun saveProgress(positionSeconds: Int, durationSeconds: Int, finished: Boolean) {
        saves += Triple(positionSeconds, durationSeconds, finished)
    }
    override fun beat(paused: Boolean, onLost: (String) -> Unit) {
        beats++
        lose?.let(onLost)
    }
    override fun end() {
        ended++
    }
}

private fun manifest(
    skips: List<SceneSkip> = emptyList(),
    skipSegments: List<SkipSegment> = emptyList(),
    autoSkip: Map<String, Boolean> = emptyMap(),
    heartbeat: Boolean = false,
    notice: String? = null,
) = PlayManifest(
    heartbeat = heartbeat,
    durationSeconds = 200.0,
    segments = listOf(PlaySegment(0, "a", 100.0, 0.0), PlaySegment(1, "b", 100.0, 100.0)),
    skips = skips, skipSegments = skipSegments, autoSkip = autoSkip, notice = notice,
)

private class Rig(m: PlayManifest, skipInsteadOfMute: Boolean = false, keepsPlace: Boolean = true) {
    val engine = FakeEngine()
    val reporter = RecordingReporter()
    var now = 1_000_000L
    val session = PlaybackSession(m, engine, reporter, { now }, skipInsteadOfMute, keepsPlace)
    fun at(position: Double, item: Int = 0) {
        engine.position = position
        engine.item = item
        session.tick()
    }
    fun stopAndFinish() {
        engine.playing = false
        repeat(PlaybackSession.IDLE_TICKS) { session.tick() }
    }
}

class PlaybackSessionTest {
    // ── scenes ──
    @Test fun aSceneToSkipIsJumpedOverOnce() {
        val r = Rig(manifest(skips = listOf(SceneSkip(10.0, 20.0, "skip"))))
        r.at(10.5)
        assertEquals(listOf("seek 20.0"), r.engine.log)
        r.engine.log.clear()
        r.at(20.1)
        assertEquals(emptyList<String>(), r.engine.log)
    }

    @Test fun aSkipThatReachesIntoTheNextFileOpensIt() {
        val r = Rig(manifest(skips = listOf(SceneSkip(90.0, 120.0, "skip"))))
        r.at(95.0)
        assertEquals(listOf("item 1 20.0"), r.engine.log)
    }

    @Test fun aSceneToMuteSwitchesTheSoundOffAndBackOn() {
        val r = Rig(manifest(skips = listOf(SceneSkip(10.0, 12.0, "mute"))))
        r.at(10.5)
        r.at(10.6)
        assertEquals(listOf("mute true"), r.engine.log)
        r.at(12.5)
        assertEquals(listOf("mute true", "mute false"), r.engine.log)
    }

    @Test fun theSettingThatSkipsMutedScenesDoesSo() {
        val r = Rig(manifest(skips = listOf(SceneSkip(10.0, 12.0, "mute"))), skipInsteadOfMute = true)
        r.at(10.5)
        assertEquals(listOf("seek 12.0"), r.engine.log)
    }

    @Test fun theSoundComesBackIfPlaybackStopsInAMutedScene() {
        val r = Rig(manifest(skips = listOf(SceneSkip(10.0, 12.0, "mute"))))
        r.at(10.5)
        r.stopAndFinish()
        assertEquals("mute false", r.engine.log.last())
    }

    // ── buttons ──
    private val intro = listOf(SkipSegment("intro", 10.0, 40.0))

    @Test fun theButtonIsOfferedAndPressingItSkips() {
        val r = Rig(manifest(skipSegments = intro))
        r.at(20.0)
        assertEquals("Skip intro", r.session.ui.value.offer?.label)
        r.session.pressSkip()
        assertEquals(listOf("seek 40.0"), r.engine.log)
        assertNull(r.session.ui.value.offer)
    }

    @Test fun dismissingItMeansItIsNotOfferedAgainForThatKind() {
        val r = Rig(manifest(skipSegments = intro))
        r.at(20.0)
        r.session.dismissSkip()
        r.at(21.0)
        assertNull(r.session.ui.value.offer)
    }

    @Test fun aProfileThatSkipsIntrosByItselfDoesSoOnce() {
        val r = Rig(manifest(skipSegments = intro, autoSkip = mapOf("intro" to true)))
        r.at(12.0)
        assertEquals(listOf("seek 40.0"), r.engine.log)
        r.engine.log.clear()
        r.at(20.0) // went back into the intro on purpose
        assertEquals("Skip intro", r.session.ui.value.offer?.label)
        assertEquals(emptyList<String>(), r.engine.log)
    }

    @Test fun noButtonOutsideThePart() {
        val r = Rig(manifest(skipSegments = intro))
        r.at(50.0)
        assertNull(r.session.ui.value.offer)
    }

    // ── remembering ──
    @Test fun thePlaceIsSentEveryFifteenSeconds() {
        val r = Rig(manifest())
        r.at(30.0)
        assertTrue(r.reporter.saves.isEmpty())
        r.now += 15_000
        r.at(45.0)
        assertEquals(listOf(Triple(45, 200, false)), r.reporter.saves)
    }

    @Test fun stoppingEarlyRemembersWhereAndEndsOnlyAfterACoupleOfSeconds() {
        val r = Rig(manifest())
        r.at(50.0)
        r.engine.playing = false
        repeat(PlaybackSession.IDLE_TICKS - 1) { assertTrue(r.session.tick()) }
        assertFalse(r.session.tick())
        assertEquals(listOf(Triple(50, 200, false)), r.reporter.saves)
        assertFalse(r.session.tick())
        assertEquals(1, r.reporter.saves.size)
        assertTrue(r.session.ui.value.ended)
    }

    @Test fun aFilmWatchedToTheEndIsFinished() {
        val r = Rig(manifest())
        r.at(95.0, item = 1)
        r.stopAndFinish()
        assertTrue(r.reporter.saves.last().third)
        assertTrue(r.session.ui.value.finished)
    }

    @Test fun playbackThatNeverStartedSavesNothingSoTheOldPlaceSurvives() {
        val r = Rig(manifest())
        r.engine.playing = false
        repeat(PlaybackSession.IDLE_TICKS) { r.session.tick() }
        assertTrue(r.reporter.saves.isEmpty())
    }

    @Test fun somethingThatKeepsNoPlaceSavesNothing() {
        val r = Rig(manifest(), keepsPlace = false)
        r.at(5.0)
        r.now += 20_000
        r.at(6.0)
        r.stopAndFinish()
        assertTrue(r.reporter.saves.isEmpty())
    }

    @Test fun leavingTheScreenSavesWhereAndLetsGoOfThePlace() {
        val r = Rig(manifest(heartbeat = true))
        r.at(60.0)
        r.session.close()
        assertEquals(listOf(Triple(60, 200, false)), r.reporter.saves)
        assertEquals(1, r.reporter.ended)
        r.session.close() // twice is once
        assertEquals(1, r.reporter.saves.size)
    }

    // ── the limit on playing at once ──
    @Test fun itHoldsItsPlaceAndLetsGo() {
        val r = Rig(manifest(heartbeat = true))
        r.now += 31_000
        r.at(10.0)
        assertEquals(1, r.reporter.beats)
        r.stopAndFinish()
        assertEquals(1, r.reporter.ended)
    }

    @Test fun losingThePlaceStopsPlaybackAndSaysWhy() {
        val r = Rig(manifest(heartbeat = true))
        r.reporter.lose = "The owner has withdrawn this."
        r.now += 31_000
        r.at(10.0)
        assertEquals("The owner has withdrawn this.", r.session.ui.value.lostMessage)
        assertTrue("stop" in r.engine.log)
    }

    @Test fun noHeartbeatWhenTheServerDoesNotAskForOne() {
        val r = Rig(manifest())
        r.now += 100_000
        r.at(10.0)
        assertEquals(0, r.reporter.beats)
    }

    @Test fun aNoticeIsThereFromTheStartAndCanBeCleared() {
        val r = Rig(manifest(notice = "Some filtering couldn't be applied."))
        assertEquals("Some filtering couldn't be applied.", r.session.ui.value.notice)
        r.session.clearNotice()
        assertNull(r.session.ui.value.notice)
    }
}
