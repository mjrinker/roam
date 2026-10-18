package com.roam.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.roam.app.data.DownloadManager
import com.roam.app.data.DownloadRecord
import com.roam.app.data.DownloadStore
import com.roam.app.data.PlayManifest
import com.roam.app.data.PlaySegment
import com.roam.app.data.RoamApi
import com.roam.app.data.Unsupported
import com.roam.app.data.VersionOption
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private class MemoryStore(val records: MutableList<DownloadRecord> = mutableListOf()) : DownloadStore {
    override fun list() = records.toList()
    override fun put(record: DownloadRecord) { records.removeAll { it.kind == record.kind && it.id == record.id }; records += record }
    override fun remove(kind: String, id: String) { records.removeAll { it.kind == kind && it.id == id } }
    override fun folderFor(kind: String, id: String) = File(System.getProperty("java.io.tmpdir"), "roam-ui-dl-$kind-$id").apply { mkdirs() }
}

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w1200dp-h3000dp-xhdpi")
class DownloadsScreenTest {
    @get:Rule val rule = createComposeRule()

    private fun manager(store: DownloadStore) = DownloadManager(store, CoroutineScope(SupervisorJob() + Dispatchers.IO))
    private val manifest = PlayManifest(durationSeconds = 60.0, segments = listOf(PlaySegment(0, "file:///x/part0.mp4", 60.0, 0.0, container = "mp4")), version = "720p")
    private fun record(id: String, name: String) = DownloadRecord("title", id, name, "2001", "720p", 5L shl 20, manifest)

    @Test fun aSavedVideoShowsAsSavedAndOffersNoSecondDownload() {
        val store = MemoryStore(mutableListOf(record("m1", "The Film")))
        rule.setContent { Shown(testGraph(Unsupported, downloads = manager(store))) { DownloadControl("title", "m1", "The Film", "2001") } }
        rule.waitForIdle()
        rule.onNodeWithTag("download-saved").assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithTagCount("download"))
    }

    @Test fun downloadAsksForAQualityWhenThereAreSeveralAndStartsTheOneChosen() {
        val asked = mutableListOf<String>()
        val api = object : RoamApi by Unsupported {
            override suspend fun play(kind: String, id: String, unsupportedCodecs: String) = manifest.copy(versions = listOf(VersionOption("1080p", "1080p"), VersionOption("720p", "720p")), version = "1080p")
            override suspend fun playVersion(kind: String, id: String, unsupportedCodecs: String, version: String): PlayManifest { asked += version; return manifest.copy(version = version) }
        }
        val store = MemoryStore()
        rule.setContent { Shown(testGraph(api, downloads = manager(store))) { DownloadControl("title", "m1", "The Film", "2001") } }
        rule.onNodeWithTag("download").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("download-version-720p").performClick()
        rule.waitForIdle()
        assertEquals(listOf("720p"), asked)
    }

    @Test fun theDownloadsScreenListsWhatIsSavedPlaysItAndRemovesIt() {
        val store = MemoryStore(mutableListOf(record("m1", "The Film"), record("m2", "Another")))
        val nav = FakeNav()
        rule.setContent { Shown(testGraph(Unsupported, downloads = manager(store))) { DownloadsScreen(nav) } }
        rule.waitForIdle()
        rule.onNodeWithText("The Film").assertIsDisplayed()
        rule.onNodeWithTag("saved-m1").performClick()
        assertEquals(listOf(Routes.offlinePlayer("title", "m1")), nav.routes)
        rule.onNodeWithTag("remove-m2").performClick()
        rule.waitForIdle()
        assertTrue(store.records.map { it.id } == listOf("m1"))
    }

    @Test fun anEmptyDownloadsScreenSaysHowToSaveSomething() {
        rule.setContent { Shown(testGraph(Unsupported)) { DownloadsScreen(FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithText("Nothing saved yet. Open a movie or an episode and press Download.").assertIsDisplayed()
    }
}
