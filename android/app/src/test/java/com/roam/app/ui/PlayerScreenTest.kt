package com.roam.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.roam.app.AppGraph
import com.roam.app.data.ApiException
import com.roam.app.data.MemorySettings
import com.roam.app.data.PlayManifest
import com.roam.app.data.PlaySegment
import com.roam.app.data.RoamApi
import com.roam.app.data.SceneSkip
import com.roam.app.data.SkipSegment
import com.roam.app.data.Unsupported
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

private fun manifest(
    heartbeat: Boolean = false,
    notice: String? = null,
    skipSegments: List<SkipSegment> = emptyList(),
    skips: List<SceneSkip> = emptyList(),
    resume: Double = 0.0,
) = PlayManifest(
    heartbeat = heartbeat, durationSeconds = 200.0, resumeSeconds = resume, notice = notice, skipSegments = skipSegments, skips = skips,
    segments = listOf(
        PlaySegment(0, "https://box/1", 100.0, 0.0, container = "mp4"),
        PlaySegment(1, "https://box/2", 100.0, 100.0, inFileOffsetSeconds = 10.0, inFileEndSeconds = 110.0, container = "mkv"),
    ),
)

@RunWith(RobolectricTestRunner::class)
class PlayerScreenTest {
    @get:Rule val rule = createComposeRule()

    private fun show(api: RoamApi, nav: FakeNav = FakeNav(), kind: String = "title", queue: List<String> = emptyList(), onNext: (String, List<String>) -> Unit = { _, _ -> }, startAt: Double? = null, startOver: Boolean = false, unsupported: String = "") {
        val graph = AppGraph(MemorySettings(token = "t"), api, isTv = false, unsupportedAudio = { unsupported })
        rule.setContent { Shown(graph) { PlayerScreen(kind, "m1", "The Film", startOver, startAt, queue, nav, onNext) } }
    }

    @Test fun whenEveryCopyIsBeingPlayedItSaysSoAndOffersToTellYou() {
        var told: String? = null
        val api = object : RoamApi by Unsupported {
            override suspend fun play(kind: String, id: String, unsupportedCodecs: String): PlayManifest = throw ApiException(423, "The only copy is being played right now.", "busy")
            override suspend fun watchWhenFree(titleId: String, seasonId: String?) {
                told = titleId
            }
        }
        show(api)
        rule.waitForIdle()
        rule.onNodeWithText("The only copy is being played right now.").assertIsDisplayed()
        rule.onNodeWithTag("tell-me").performClick()
        rule.waitForIdle()
        assertEquals("m1", told)
        rule.onNodeWithText("You'll be told").assertIsDisplayed()
    }

    @Test fun whenEveryCopyIsWithdrawnThereIsNothingToWaitFor() {
        val api = object : RoamApi by Unsupported {
            override suspend fun play(kind: String, id: String, unsupportedCodecs: String): PlayManifest = throw ApiException(423, "Everyone who owns a copy has withdrawn it.", "withdrawn")
        }
        val nav = FakeNav()
        show(api, nav)
        rule.waitForIdle()
        rule.onNodeWithText("Everyone who owns a copy has withdrawn it.").assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithTag("tell-me").fetchSemanticsNodes().size)
        rule.onNodeWithTag("go-back").performClick()
        assertEquals(1, nav.backs)
    }

    @Test fun aRefusedSignInGoesToSignIn() {
        val api = object : RoamApi by Unsupported {
            override suspend fun play(kind: String, id: String, unsupportedCodecs: String): PlayManifest = throw ApiException(401, "Sign in required", "unauthorized")
        }
        val nav = FakeNav()
        show(api, nav)
        rule.waitForIdle()
        assertEquals(1, nav.signedOuts)
    }

    @Test fun noConnectionIsSaidInWordsAndCanBeRetried() {
        var tries = 0
        val api = object : RoamApi by Unsupported {
            override suspend fun play(kind: String, id: String, unsupportedCodecs: String): PlayManifest {
                if (++tries == 1) throw ApiException(0, "down", "network")
                return manifest()
            }
        }
        show(api)
        rule.waitForIdle()
        rule.onNodeWithText("Roam can't be reached", substring = true).assertIsDisplayed()
        rule.onNodeWithText("Try again").performClick()
        rule.waitForIdle()
        assertEquals(2, tries)
        rule.onNodeWithTag("player").assertIsDisplayed()
    }

    @Test fun itAsksTheServerToConvertTheAudioThisDeviceCantPlay() {
        var asked: String? = null
        val api = object : RoamApi by Unsupported {
            override suspend fun play(kind: String, id: String, unsupportedCodecs: String): PlayManifest {
                asked = unsupportedCodecs
                return manifest()
            }
        }
        show(api, unsupported = "dtsc,dtsh")
        rule.waitForIdle()
        assertEquals("dtsc,dtsh", asked)
    }

    // ── the player itself, with a player that does what the test says ──
    private fun host(m: PlayManifest, engine: FakeEngine, reporter: FakeReporter = FakeReporter(), nav: FakeNav = FakeNav(), onFinished: (Boolean) -> Unit = {}, started: MutableList<Triple<Int, Long, Int>>? = null) {
        val graph = AppGraph(MemorySettings(token = "t"), Unsupported, isTv = false)
        rule.setContent {
            Shown(graph) {
                PlayerHost(
                    manifest = m, items = emptyList(), startSeconds = m.resumeSeconds, kind = "title", id = "m1", keepsPlace = true, audioOnly = false, nav = nav,
                    onFinished = onFinished, onError = {}, engineFor = { engine }, reporterFor = { reporter },
                    begin = { _, index, ms -> started?.add(Triple(index, ms, 0)) },
                )
            }
        }
    }

    @Test fun startsInTheRightFileAtTheRightSecond() {
        val started = mutableListOf<Triple<Int, Long, Int>>()
        host(manifest(resume = 130.0), FakeEngine(), started = started)
        rule.waitForIdle()
        assertEquals(listOf(Triple(1, 30_000L, 0)), started)
    }

    @Test fun theSkipButtonAppearsInAnIntroAndPressingItSkips() {
        val engine = FakeEngine().apply { position = 20.0 }
        host(manifest(skipSegments = listOf(SkipSegment("intro", 10.0, 40.0))), engine)
        rule.mainClock.advanceTimeBy(600)
        rule.onNodeWithText("Skip intro").assertIsDisplayed()
        rule.onNodeWithTag("skip").performClick()
        rule.mainClock.advanceTimeBy(300)
        assertTrue("seek 40.0" in engine.log)
    }

    @Test fun noSkipButtonOutsideAnIntro() {
        val engine = FakeEngine().apply { position = 60.0 }
        host(manifest(skipSegments = listOf(SkipSegment("intro", 10.0, 40.0))), engine)
        rule.mainClock.advanceTimeBy(600)
        assertEquals(0, rule.onAllNodesWithTag("skip").fetchSemanticsNodes().size)
    }

    @Test fun aSceneToSkipIsJumpedOver() {
        val engine = FakeEngine().apply { position = 12.0 }
        host(manifest(skips = listOf(SceneSkip(10.0, 20.0, "skip"))), engine)
        rule.mainClock.advanceTimeBy(600)
        assertTrue("seek 20.0" in engine.log)
    }

    @Test fun theNoticeIsShownThenGoesAway() {
        host(manifest(notice = "Some filtering couldn't be applied."), FakeEngine())
        rule.mainClock.advanceTimeBy(500)
        rule.onNodeWithTag("notice").assertIsDisplayed()
        rule.mainClock.advanceTimeBy(8_000)
        rule.waitForIdle()
        assertEquals(0, rule.onAllNodesWithTag("notice").fetchSemanticsNodes().size)
    }

    @Test fun whenPlaybackEndsItSaysWhetherTheFilmWasFinished() {
        val engine = FakeEngine().apply { item = 1; position = 95.0 }
        val reporter = FakeReporter()
        var result: Boolean? = null
        host(manifest(), engine, reporter, onFinished = { result = it })
        rule.mainClock.advanceTimeBy(600)
        engine.playing = false
        rule.mainClock.advanceTimeBy(4_000)
        rule.waitForIdle()
        assertEquals(true, result)
        assertTrue(reporter.saves.last().third)
    }

    @Test fun stoppedEarlyIsNotFinished() {
        val engine = FakeEngine().apply { position = 30.0 }
        val reporter = FakeReporter()
        var result: Boolean? = null
        host(manifest(), engine, reporter, onFinished = { result = it })
        rule.mainClock.advanceTimeBy(600)
        engine.playing = false
        rule.mainClock.advanceTimeBy(4_000)
        rule.waitForIdle()
        assertEquals(false, result)
        assertEquals(Triple(30, 200, false), reporter.saves.last())
    }

    @Test fun losingThePlaceStopsAndSaysWhy() {
        val engine = FakeEngine().apply { position = 10.0 }
        val reporter = FakeReporter().apply { lose = "The owner has withdrawn this." }
        val nav = FakeNav()
        val graph = AppGraph(MemorySettings(token = "t"), Unsupported, isTv = false, clockMs = run { var t = 0L; { t += 40_000; t } })
        rule.setContent {
            Shown(graph) {
                PlayerHost(manifest(heartbeat = true), emptyList(), 0.0, "title", "m1", true, false, nav, onFinished = {}, onError = {}, engineFor = { engine }, reporterFor = { reporter }, begin = { _, _, _ -> })
            }
        }
        rule.mainClock.advanceTimeBy(600)
        rule.waitForIdle()
        rule.onNodeWithTag("lost").assertIsDisplayed()
        assertTrue("stop" in engine.log)
    }
}
