package com.roam.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.roam.app.data.ApiItem
import com.roam.app.data.ItemsPage
import com.roam.app.data.PhotoRef
import com.roam.app.data.PhotoView
import com.roam.app.data.RoamApi
import com.roam.app.data.Unsupported
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private fun photo(id: String, prev: String? = null, next: String? = null, favorite: Boolean = false, nextType: String = "photo") =
    PhotoView(id, "photo", "Photo $id", "2026-01-02T00:00:00.000Z", favorite, "", "/api/photos/$id/preview", prev?.let { PhotoRef("photo", it) }, next?.let { PhotoRef(nextType, it) })

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w1200dp-h3000dp-xhdpi")
class PhotosScreenTest {
    @get:Rule val rule = createComposeRule()

    @Test fun aPhotoLibraryShowsTheTimelineAndItsPicturesOpenTheViewer() {
        val nav = FakeNav()
        val seen = mutableListOf<List<String?>>()
        val api = object : RoamApi by Unsupported {
            override suspend fun photos(serverId: String, libraryId: String, view: String?, path: String?, after: String?): ItemsPage {
                seen += listOf(view, path, after)
                return ItemsPage(items = listOf(ApiItem("photo", "p1", "IMG 1", "2026-01-02", "/api/photos/p1/thumb?v=1", true), ApiItem("clip", "c1", "Clip", null, null, true)))
            }
        }
        rule.setContent { Shown(testGraph(api)) { LibraryScreen("S", "L", "timeline", "Photos", nav) } }
        rule.waitForIdle()
        assertEquals(listOf(listOf<String?>(null, null, null)), seen)
        rule.onNodeWithTag("card-p1").performClick()
        rule.onNodeWithTag("card-c1").performClick()
        assertEquals(listOf(Routes.photo("S", "p1", "timeline"), Routes.player("title", "c1", "Clip")), nav.routes)
    }

    @Test fun favouritesAndAlbumsAreTheirOwnViewsAndPicturesOpenWithThatOrder() {
        val nav = FakeNav()
        val seen = mutableListOf<List<String?>>()
        val api = object : RoamApi by Unsupported {
            override suspend fun photos(serverId: String, libraryId: String, view: String?, path: String?, after: String?): ItemsPage {
                seen += listOf(view, path, after)
                return if (view == "albums" && path.isNullOrEmpty()) ItemsPage(path = "", folders = listOf("Trip"))
                else if (view == "albums") ItemsPage(path = path, items = listOf(ApiItem("photo", "a1", "In album", null, null, true)))
                else ItemsPage(items = listOf(ApiItem("photo", "f1", "Fave", null, null, true)))
            }
        }
        rule.setContent { Shown(testGraph(api)) { LibraryScreen("S", "L", "timeline", "Photos", nav) } }
        rule.waitForIdle()
        rule.onNodeWithTag("mode-favorites").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("card-f1").performClick()
        rule.onNodeWithTag("mode-albums").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("folder-Trip").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("card-a1").performClick()
        assertEquals(listOf(Routes.photo("S", "f1", "favorites"), Routes.photo("S", "a1", "album")), nav.routes)
        assertEquals(listOf<String?>("albums", "Trip", null), seen.last())
    }

    @Test fun theViewerMovesBetweenPicturesAndKeepsTheOrderItWasOpenedFrom() {
        val asked = mutableListOf<String>()
        val api = object : RoamApi by Unsupported {
            override suspend fun photo(serverId: String, id: String, from: String): PhotoView {
                asked += "$id/$from"
                return when (id) {
                    "a" -> photo("a", next = "b")
                    "b" -> photo("b", prev = "a", next = "c")
                    else -> photo("c", prev = "b")
                }
            }
        }
        rule.setContent { Shown(testGraph(api)) { PhotoScreen("S", "b", "favorites", FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithText("Photo b  ·  2026-01-02").assertIsDisplayed()
        rule.onNodeWithTag("photo-next").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Photo c  ·  2026-01-02").assertIsDisplayed()
        rule.onNodeWithTag("photo-prev").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("photo-prev").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Photo a  ·  2026-01-02").assertIsDisplayed()
        assertEquals(listOf("b/favorites", "c/favorites", "b/favorites", "a/favorites"), asked)
    }

    @Test fun aClipBesideThePicturesOpensInThePlayer() {
        val nav = FakeNav()
        val api = object : RoamApi by Unsupported {
            override suspend fun photo(serverId: String, id: String, from: String) = photo("a", next = "c1", nextType = "clip")
        }
        rule.setContent { Shown(testGraph(api)) { PhotoScreen("S", "a", "timeline", nav) } }
        rule.waitForIdle()
        rule.onNodeWithTag("photo-next").performClick()
        assertEquals(listOf(Routes.player("title", "c1", "")), nav.routes)
    }

    @Test fun markingAFavouriteIsSavedAndShown_andAFailureIsSaid() {
        val calls = mutableListOf<Pair<String, Boolean>>()
        var fail = false
        val api = object : RoamApi by Unsupported {
            override suspend fun photo(serverId: String, id: String, from: String) = photo("a", favorite = false)
            override suspend fun setFavorite(photoId: String, favorite: Boolean) {
                if (fail) throw com.roam.app.data.ApiException(0, "x", "network")
                calls += photoId to favorite
            }
        }
        rule.setContent { Shown(testGraph(api)) { PhotoScreen("S", "a", "timeline", FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithText("☆ Favourite").assertIsDisplayed()
        rule.onNodeWithTag("favorite").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("★ Favourite").assertIsDisplayed()
        fail = true
        rule.onNodeWithTag("favorite").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Roam can't be reached.").assertIsDisplayed()
        rule.onNodeWithText("★ Favourite").assertIsDisplayed() // unchanged: it wasn't saved
        assertEquals(listOf("a" to true), calls)
    }

    @Test fun theSlideshowAdvancesByItselfAndStopsAtTheEnd() {
        val api = object : RoamApi by Unsupported {
            override suspend fun photo(serverId: String, id: String, from: String) = when (id) {
                "a" -> photo("a", next = "b")
                else -> photo("b", prev = "a")
            }
        }
        rule.setContent { Shown(testGraph(api)) { PhotoScreen("S", "a", "timeline", FakeNav(), slideshowMs = 1000) } }
        rule.waitForIdle()
        rule.onNodeWithTag("slideshow").performClick()
        rule.onNodeWithText("Stop slideshow").assertIsDisplayed()
        rule.mainClock.advanceTimeBy(1500)
        rule.waitForIdle()
        rule.onNodeWithText("Photo b  ·  2026-01-02").assertIsDisplayed()
        rule.mainClock.advanceTimeBy(1500)
        rule.waitForIdle()
        rule.onNodeWithText("Slideshow").assertIsDisplayed() // the last picture: it stopped
    }
}
