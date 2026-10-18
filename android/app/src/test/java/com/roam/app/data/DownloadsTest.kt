package com.roam.app.data

import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.delay
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class DownloadsTest {
    private lateinit var server: MockWebServer
    private lateinit var dir: File
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Before fun start() {
        server = MockWebServer().apply { start() }
        dir = createTempDir("roam-downloads")
    }

    @After fun stop() {
        server.shutdown()
        dir.deleteRecursively()
    }

    private fun manifest(vararg sizes: Int) = PlayManifest(
        durationSeconds = 100.0,
        segments = sizes.mapIndexed { i, n -> PlaySegment(i, server.url("/file$i").toString(), 50.0, i * 50.0, container = "mp4", sizeBytes = n.toLong()) },
        versions = listOf(VersionOption("720p", "720p")),
    )

    private suspend fun waitFor(what: () -> Boolean) = withTimeout(10_000) { while (!what()) delay(20) }

    @Test fun savesEveryPartAndRecordsAManifestThatPointsAtTheSavedFiles() = runBlocking {
        server.enqueue(MockResponse().setBody(Buffer().write(ByteArray(2000) { 1 })))
        server.enqueue(MockResponse().setBody(Buffer().write(ByteArray(3000) { 2 })))
        val manager = DownloadManager(FileDownloadStore(dir), scope)
        manager.start(manifest(2000, 3000), "title", "m1", "The Film", "2001", "720p")
        waitFor { manager.record("title", "m1") != null }
        val r = manager.record("title", "m1")!!
        assertEquals(5000L, r.bytes)
        assertEquals("The Film", r.name)
        assertTrue(r.manifest.segments.all { it.url.startsWith("file:") })
        assertEquals(listOf(2000L, 3000L), r.manifest.segments.map { File(java.net.URI(it.url)).length() })
        assertTrue(r.manifest.versions.isEmpty())
        assertTrue(manager.active.value.isEmpty())
    }

    @Test fun aFailedDownloadSaysSoAndLeavesNothingBehind() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(403))
        val manager = DownloadManager(FileDownloadStore(dir), scope)
        manager.start(manifest(100), "title", "m2", "Bad", null, null)
        waitFor { manager.active.value["title-m2"]?.error != null }
        assertTrue(manager.active.value["title-m2"]!!.error!!.contains("403"))
        assertNull(manager.record("title", "m2"))
        assertFalse(File(dir, "title-m2").exists())
        manager.dismissError("title", "m2")
        assertTrue(manager.active.value.isEmpty())
    }

    @Test fun savedVideosSurviveARestartAndCanBeRemoved() = runBlocking {
        server.enqueue(MockResponse().setBody(Buffer().write(ByteArray(10))))
        val first = DownloadManager(FileDownloadStore(dir), scope)
        first.start(manifest(10), "episode", "e1", "Show", "S1 · E1", null)
        waitFor { first.record("episode", "e1") != null }
        val second = DownloadManager(FileDownloadStore(dir), scope)
        assertNotNull(second.record("episode", "e1"))
        assertEquals(1, second.saved().size)
        // the same video isn't downloaded again while it is saved
        second.start(manifest(10), "episode", "e1", "Show", null, null)
        delay(300)
        assertEquals(1, server.requestCount)
        second.remove("episode", "e1")
        assertNull(second.record("episode", "e1"))
        assertFalse(File(dir, "episode-e1").exists())
    }
}
