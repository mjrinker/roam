package com.roam.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.roam.app.data.Home
import com.roam.app.data.PlaylistEntry
import com.roam.app.data.PlaylistHeader
import com.roam.app.data.PlaylistPage
import com.roam.app.data.PlaylistSummary
import com.roam.app.data.RoamApi
import com.roam.app.data.ServerRef
import com.roam.app.data.Unsupported
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private fun ep(entry: String, id: String, name: String = "Ep $id", playable: Boolean = true) = PlaylistEntry(entry, "episode", id, name, "S1 · E1", playable = playable)
private fun film(entry: String, id: String) = PlaylistEntry(entry, "movie", id, "Film $id", "2001")
private val header = PlaylistHeader("P1", "Friday night", "for the family", 4, "Matt")

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w1200dp-h3000dp-xhdpi")
class PlaylistsScreenTest {
    @get:Rule val rule = createComposeRule()

    @Test fun homeShowsAPlaylistsButtonOnlyWhenThereAreSome() {
        val nav = FakeNav()
        var has = true
        val api = object : RoamApi by Unsupported {
            override suspend fun home(serverId: String) = Home(ServerRef("S", "Server"), hasPlaylists = has)
        }
        rule.setContent { Shown(testGraph(api)) { HomeScreen("S", nav) } }
        rule.waitForIdle()
        rule.onNodeWithTag("go-playlists").performClick()
        assertEquals(listOf(Routes.playlists("S")), nav.routes)
    }

    @Test fun homeHasNoPlaylistsButtonWithoutPlaylists() {
        val api = object : RoamApi by Unsupported {
            override suspend fun home(serverId: String) = Home(ServerRef("S", "Server"), hasPlaylists = false)
        }
        rule.setContent { Shown(testGraph(api)) { HomeScreen("S", FakeNav()) } }
        rule.waitForIdle()
        assertEquals(0, rule.onAllNodesWithTagCount("go-playlists"))
    }

    @Test fun homeGivesRoamThisDevicesPushRegistrationWhenPushIsSetUp() {
        val registered = mutableListOf<RoamApi>()
        val api = object : RoamApi by Unsupported {
            override suspend fun home(serverId: String) = Home(ServerRef("S", "Server"))
        }
        val withPush = object : com.roam.app.push.PushRegistrar {
            override val available = true
            override suspend fun register(api: RoamApi) { registered += api }
        }
        rule.setContent { Shown(testGraph(api).let { com.roam.app.AppGraph(it.settings, it.api, it.isTv, deviceName = it.deviceName, push = withPush) }) { HomeScreen("S", FakeNav()) } }
        rule.waitForIdle()
        assertEquals(1, registered.size)
    }

    @Test fun homeAsksNothingOfPushWhenItIsNotSetUp() {
        val api = object : RoamApi by Unsupported {
            override suspend fun home(serverId: String) = Home(ServerRef("S", "Server"))
        }
        rule.setContent { Shown(testGraph(api)) { HomeScreen("S", FakeNav()) } } // the default graph has no push, and Unsupported would throw if it were asked
        rule.waitForIdle()
        rule.onNodeWithText("Server").assertIsDisplayed()
    }

    @Test fun listsThePlaylistsAndOpensOne() {
        val nav = FakeNav()
        val api = object : RoamApi by Unsupported {
            override suspend fun playlists(serverId: String) = listOf(PlaylistSummary("P1", "Friday night", 4, "Matt"), PlaylistSummary("P2", "Solo", 1))
        }
        rule.setContent { Shown(testGraph(api)) { PlaylistsScreen("S", nav) } }
        rule.waitForIdle()
        rule.onNodeWithText("4 items · Matt").assertIsDisplayed()
        rule.onNodeWithText("1 item").assertIsDisplayed()
        rule.onNodeWithTag("playlist-P1").performClick()
        assertEquals(listOf(Routes.playlist("S", "P1")), nav.routes)
    }

    @Test fun saysSoWhenThereAreNone() {
        val api = object : RoamApi by Unsupported {
            override suspend fun playlists(serverId: String) = emptyList<PlaylistSummary>()
        }
        rule.setContent { Shown(testGraph(api)) { PlaylistsScreen("S", FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithText("No playlists yet. Make one on the web.").assertIsDisplayed()
    }

    @Test fun anEpisodePlaysAtOnceWithTheEpisodesAfterItQueuedAndAMovieOpensItsPage() {
        val nav = FakeNav()
        val api = object : RoamApi by Unsupported {
            override suspend fun playlist(serverId: String, id: String, after: String?) =
                PlaylistPage(header, listOf(ep("a", "e1"), ep("b", "e2"), ep("c", "e3", playable = false), film("d", "m1"), ep("e", "e4")))
        }
        rule.setContent { Shown(testGraph(api)) { PlaylistScreen("S", "P1", nav) } }
        rule.waitForIdle()
        rule.onNodeWithText("Friday night").assertIsDisplayed()
        rule.onNodeWithTag("entry-a").performClick()
        rule.onNodeWithTag("entry-d").performClick()
        rule.onNodeWithTag("entry-c").performClick() // not playable: nothing happens
        assertEquals(listOf(Routes.player("episode", "e1", "Ep e1", queue = listOf("e2")), Routes.title("S", "m1")), nav.routes)
    }

    @Test fun playStartsFromTheFirstThingThatCanBePlayed() {
        val nav = FakeNav()
        val api = object : RoamApi by Unsupported {
            override suspend fun playlist(serverId: String, id: String, after: String?) =
                PlaylistPage(header, listOf(PlaylistEntry("s", "show", "sh1", "A Show", playable = false), ep("a", "e1"), ep("b", "e2")))
        }
        rule.setContent { Shown(testGraph(api)) { PlaylistScreen("S", "P1", nav) } }
        rule.waitForIdle()
        rule.onNodeWithTag("play-all").performClick()
        assertEquals(listOf(Routes.player("episode", "e1", "Ep e1", queue = listOf("e2"))), nav.routes)
    }

    @Test fun showMoreFetchesTheNextPageAndKeepsWhatIsThere() {
        val seen = mutableListOf<String?>()
        val api = object : RoamApi by Unsupported {
            override suspend fun playlist(serverId: String, id: String, after: String?): PlaylistPage {
                seen += after
                return if (after == null) PlaylistPage(header, listOf(film("a", "m1")), next = "1024~x") else PlaylistPage(header, listOf(film("b", "m2")))
            }
        }
        rule.setContent { Shown(testGraph(api)) { PlaylistScreen("S", "P1", FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithTag("more").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Film m1").assertIsDisplayed()
        rule.onNodeWithText("Film m2").assertIsDisplayed()
        assertEquals(listOf(null, "1024~x"), seen)
        assertEquals(0, rule.onAllNodesWithTagCount("more"))
    }
}
