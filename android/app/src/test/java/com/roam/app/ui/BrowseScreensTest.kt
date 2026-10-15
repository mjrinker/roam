package com.roam.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.roam.app.data.Album
import com.roam.app.data.ApiException
import com.roam.app.data.ApiItem
import com.roam.app.data.ArtistRef
import com.roam.app.data.Home
import com.roam.app.data.ItemsPage
import com.roam.app.data.Library
import com.roam.app.data.RoamApi
import com.roam.app.data.ServerRef
import com.roam.app.data.Track
import com.roam.app.data.Unsupported
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private fun movie(id: String, name: String, progress: Double? = null) = ApiItem("movie", id, name, "2001", null, false, progress)

// A tall, wide screen, so whole lists are on it (a list only builds the rows that are in view).
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w1200dp-h3000dp-xhdpi")
class BrowseScreensTest {
    @get:Rule val rule = createComposeRule()

    private val home = Home(
        ServerRef("S", "Family server"),
        libraries = listOf(Library("L1", "Movies", "movies", "grid"), Library("L2", "Books", "ebooks", null)),
        continueWatching = listOf(movie("m1", "Half-watched", 0.4), ApiItem("episode", "e1", "The Show", "S1 · E2")),
        recentlyAdded = listOf(movie("m2", "Brand new"), ApiItem("show", "s1", "A Show"), ApiItem("album", "al1", "Songs", null, null, true)),
        unreadNotifications = 3,
    )

    @Test fun homeShowsTheRowsAndOnlyTheLibrariesThatCanBeOpened() {
        val api = object : RoamApi by Unsupported {
            override suspend fun home(serverId: String) = home
        }
        rule.setContent { Shown(testGraph(api)) { HomeScreen("S", FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithText("Family server").assertIsDisplayed()
        rule.onNodeWithText("Continue watching").assertIsDisplayed()
        rule.onNodeWithText("Recently added").assertIsDisplayed()
        rule.onNodeWithTag("library-L1").assertIsDisplayed()
        rule.onNodeWithText("Notifications (3)").assertIsDisplayed()
        assertTrue(rule.onAllNodesWithTagCount("library-L2") == 0) // an eBooks library has no way to open yet
    }

    @Test fun eachKindOfItemOpensItsOwnScreen() {
        val nav = FakeNav()
        val api = object : RoamApi by Unsupported {
            override suspend fun home(serverId: String) = home
        }
        rule.setContent { Shown(testGraph(api)) { HomeScreen("S", nav) } }
        rule.waitForIdle()
        rule.onNodeWithTag("card-m2").performClick()
        rule.onNodeWithTag("card-s1").performClick()
        rule.onNodeWithTag("card-al1").performClick()
        rule.onNodeWithTag("card-e1").performClick()
        rule.onNodeWithTag("library-L1").performClick()
        assertEquals(
            listOf(
                Routes.title("S", "m2"), Routes.title("S", "s1"), Routes.album("S", "al1"),
                Routes.player("episode", "e1", "The Show"), Routes.library("S", "L1", "grid", "Movies"),
            ),
            nav.routes,
        )
    }

    @Test fun homeButtonsGoToSearchNotificationsAndAccount() {
        val nav = FakeNav()
        val api = object : RoamApi by Unsupported {
            override suspend fun home(serverId: String) = home
        }
        rule.setContent { Shown(testGraph(api)) { HomeScreen("S", nav) } }
        rule.waitForIdle()
        rule.onNodeWithTag("go-search").performClick()
        rule.onNodeWithTag("go-notifications").performClick()
        rule.onNodeWithTag("go-account").performClick()
        assertEquals(listOf(Routes.search("S"), Routes.NOTIFICATIONS, Routes.ACCOUNT), nav.routes)
    }

    @Test fun aServerThatIsDownIsSaidInWordsWithATryAgain() {
        var tries = 0
        val api = object : RoamApi by Unsupported {
            override suspend fun home(serverId: String): Home = if (++tries == 1) throw ApiException(0, "down", "network") else home
        }
        rule.setContent { Shown(testGraph(api)) { HomeScreen("S", FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithText("Roam can't be reached", substring = true).assertIsDisplayed()
        rule.onNodeWithText("Try again").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Family server").assertIsDisplayed()
    }

    @Test fun aRefusedSignInGoesToSignIn() {
        val nav = FakeNav()
        val api = object : RoamApi by Unsupported {
            override suspend fun home(serverId: String): Home = throw ApiException(401, "Sign in required", "unauthorized")
        }
        rule.setContent { Shown(testGraph(api)) { HomeScreen("S", nav) } }
        rule.waitForIdle()
        assertEquals(1, nav.signedOuts)
    }

    // ── a library ──
    @Test fun aGridLibraryShowsItsTitlesAndLoadsTheNextPage() {
        val pages = mutableListOf<Int?>()
        val api = object : RoamApi by Unsupported {
            override suspend fun items(serverId: String, libraryId: String, page: Int?, path: String?, after: String?): ItemsPage {
                pages += page
                return if (page == 1) ItemsPage(page = 1, hasMore = true, items = listOf(movie("a", "Alpha"))) else ItemsPage(page = 2, hasMore = false, items = listOf(movie("b", "Bravo")))
            }
        }
        rule.setContent { Shown(testGraph(api)) { LibraryScreen("S", "L1", "grid", "Movies", FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithTag("card-a").assertIsDisplayed()
        rule.onNodeWithTag("card-b").assertIsDisplayed()
        assertEquals(listOf<Int?>(1, 2), pages)
    }

    @Test fun aVideoLibraryOpensFoldersInPlace() {
        val asked = mutableListOf<String?>()
        val api = object : RoamApi by Unsupported {
            override suspend fun items(serverId: String, libraryId: String, page: Int?, path: String?, after: String?): ItemsPage {
                asked += path
                return if (path.isNullOrEmpty()) ItemsPage(path = "", folders = listOf("Trips"), items = emptyList())
                else ItemsPage(path = path, folders = emptyList(), items = listOf(movie("v1", "Holiday")))
            }
        }
        rule.setContent { Shown(testGraph(api)) { LibraryScreen("S", "V", "folders", "Videos", FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithTag("folder-Trips").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("card-v1").assertIsDisplayed()
        assertEquals(listOf<String?>("", "Trips"), asked.distinct())
    }

    // ── search ──
    @Test fun searchWaitsForAPauseInTypingThenListsWhatWasFound() {
        val queries = mutableListOf<String>()
        val api = object : RoamApi by Unsupported {
            override suspend fun search(serverId: String, query: String): List<ApiItem> {
                queries += query
                return listOf(movie("m1", "The Film"))
            }
        }
        val nav = FakeNav()
        rule.setContent { Shown(testGraph(api)) { SearchScreen("S", nav) } }
        rule.onNodeWithTag("query").performTextInput("fi")
        rule.mainClock.advanceTimeBy(100)
        assertTrue(queries.isEmpty())
        rule.mainClock.advanceTimeBy(1_000)
        rule.waitForIdle()
        assertEquals(listOf("fi"), queries)
        rule.onNodeWithTag("card-m1").performClick()
        assertEquals(listOf(Routes.title("S", "m1")), nav.routes)
    }

    @Test fun searchSaysWhenNothingMatches() {
        val api = object : RoamApi by Unsupported {
            override suspend fun search(serverId: String, query: String) = emptyList<ApiItem>()
        }
        rule.setContent { Shown(testGraph(api)) { SearchScreen("S", FakeNav()) } }
        rule.onNodeWithTag("query").performTextInput("zzz")
        rule.mainClock.advanceTimeBy(1_000)
        rule.waitForIdle()
        rule.onNodeWithTag("nothing").assertIsDisplayed()
    }

    // ── music ──
    @Test fun anAlbumListsItsSongsInOrderAndEachPlaysWithoutKeepingAPlace() {
        val nav = FakeNav()
        val api = object : RoamApi by Unsupported {
            override suspend fun album(serverId: String, id: String) = Album("al1", "Songs", 2001, ArtistRef("ar1", "Artist"), null, 400.0, listOf(Track("t1", "One", number = 1, durationSeconds = 200.0), Track("t2", "Two", number = 2, durationSeconds = 200.0)))
        }
        rule.setContent { Shown(testGraph(api)) { AlbumScreen("S", "al1", nav) } }
        rule.waitForIdle()
        rule.onNodeWithText("1. One").assertIsDisplayed()
        rule.onNodeWithTag("track-t2").performClick()
        rule.onNodeWithText("Artist").performClick()
        assertEquals(listOf(Routes.audio("t2", "Two", remember = false), Routes.artist("S", "ar1")), nav.routes)
    }

    @Test fun searchOpenedByAVoiceRequestStartsWithTheWordsAlreadySaid() {
        val queries = mutableListOf<String>()
        val api = object : RoamApi by Unsupported {
            override suspend fun search(serverId: String, query: String): List<ApiItem> {
                queries += query
                return listOf(movie("m1", "The Matrix"))
            }
        }
        rule.setContent { Shown(testGraph(api)) { SearchScreen("S", FakeNav(), initialQuery = "the matrix") } }
        rule.mainClock.advanceTimeBy(1000)
        rule.waitForIdle()
        rule.onNodeWithText("The Matrix").assertIsDisplayed()
        assertEquals(listOf("the matrix"), queries)
    }
}
