package com.roam.app

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.runtime.CompositionLocalProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.roam.app.data.MemorySettings
import com.roam.app.data.PlayManifest
import com.roam.app.data.PlaySegment
import com.roam.app.data.SceneSkip
import com.roam.app.data.Unsupported
import com.roam.app.player.ExoEngine
import com.roam.app.player.PlayerEngine
import com.roam.app.player.Reporter
import com.roam.app.player.mediaItemsFor
import com.roam.app.ui.Nav
import com.roam.app.ui.PlayerHost
import com.roam.app.ui.RoamTheme
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Plays a real video (a six-second test clip, served from this test) through the real player on a real Android, which the JVM tests can't do.
 * Run with `./gradlew connectedDebugAndroidTest` with an emulator or a device attached.
 */
@RunWith(AndroidJUnit4::class)
class PlaybackInstrumentedTest {
    @get:Rule val rule = createComposeRule()
    private lateinit var server: MockWebServer
    private lateinit var video: ByteArray

    private class Reporting : Reporter {
        val saves = java.util.Collections.synchronizedList(mutableListOf<Triple<Int, Int, Boolean>>())
        override fun saveProgress(positionSeconds: Int, durationSeconds: Int, finished: Boolean) {
            saves += Triple(positionSeconds, durationSeconds, finished)
        }
        override fun beat(paused: Boolean, onLost: (String) -> Unit) = Unit
        override fun end() = Unit
    }

    /** The real player's engine, that also writes down every jump it was asked to make. */
    private class RecordingEngine(private val inner: PlayerEngine, val jumps: MutableList<String>) : PlayerEngine by inner {
        override fun seekInItem(seconds: Double) {
            jumps += "seek $seconds"
            inner.seekInItem(seconds)
        }
    }

    private class NoNav : Nav {
        override fun open(route: String) = Unit
        override fun back() = Unit
        override fun signedOut() = Unit
    }

    @Before fun serveTheClip() {
        video = InstrumentationRegistry.getInstrumentation().context.assets.open("test-video.mp4").readBytes()
        server = MockWebServer().apply {
            // A player asks for byte ranges; answer them the way a real server does.
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val range = request.getHeader("Range")?.let { Regex("bytes=(\\d+)-(\\d*)").find(it) }
                    if (range == null) return MockResponse().setBody(Buffer().write(video)).setHeader("Accept-Ranges", "bytes")
                    val from = range.groupValues[1].toInt()
                    val to = range.groupValues[2].toIntOrNull()?.coerceAtMost(video.size - 1) ?: (video.size - 1)
                    return MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes $from-$to/${video.size}").setHeader("Accept-Ranges", "bytes")
                        .setBody(Buffer().write(video, from, to - from + 1))
                }
            }
            start()
        }
    }

    @After fun stopServing() = server.shutdown()

    private fun play(manifest: PlayManifest, reporter: Reporting, jumps: MutableList<String> = mutableListOf(), onFinished: (Boolean) -> Unit) {
        val graph = AppGraph(MemorySettings(token = "t"), Unsupported, isTv = false)
        rule.setContent {
            CompositionLocalProvider(LocalGraph provides graph) {
                RoamTheme {
                    PlayerHost(manifest, mediaItemsFor(manifest, "Test clip"), 0.0, "title", "m1", true, false, NoNav(), onFinished = onFinished, onError = {}, engineFor = { RecordingEngine(ExoEngine(it), jumps) }, reporterFor = { reporter })
                }
            }
        }
    }

    private fun clip(vararg skips: SceneSkip) = PlayManifest(
        durationSeconds = 6.0, skips = skips.toList(),
        segments = listOf(PlaySegment(0, server.url("/v.mp4").toString(), 6.0, 0.0, container = "mp4")),
    )

    @Test fun playsARealVideoToTheEndAndSaysItWasFinished() {
        val reporter = Reporting()
        var finished: Boolean? = null
        play(clip(), reporter) { finished = it }
        rule.waitUntil(timeoutMillis = 90_000) { finished != null }
        assertEquals(true, finished)
        assertTrue(reporter.saves.last().third)
        assertEquals(6, reporter.saves.last().second)
    }

    @Test fun aSceneToSkipIsReallyJumpedOver() {
        val reporter = Reporting()
        val jumps = java.util.Collections.synchronizedList(mutableListOf<String>())
        var finished: Boolean? = null
        play(clip(SceneSkip(1.0, 5.0, "skip")), reporter, jumps) { finished = it }
        rule.waitUntil(timeoutMillis = 90_000) { finished != null }
        assertNotNull(finished)
        assertTrue("the player was asked to jump to 5 s: $jumps", "seek 5.0" in jumps)
    }
}
