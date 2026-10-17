package com.roam.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.roam.app.data.LabelRow
import com.roam.app.data.OnServer
import com.roam.app.data.RadioResult
import com.roam.app.data.RoamApi
import com.roam.app.data.Title
import com.roam.app.data.Unsupported
import com.roam.app.data.Wish
import com.roam.app.data.WishlistResponse
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w1200dp-h3000dp-xhdpi")
class LabelsWishlistTest {
    @get:Rule val rule = createComposeRule()

    @Test fun aTitleCanGoOnTheWatchListAndUnderALabel() {
        val calls = mutableListOf<String>()
        val api = object : RoamApi by Unsupported {
            override suspend fun setWatchlist(titleId: String, on: Boolean) { calls += "watch $titleId $on" }
            override suspend fun labelsFor(titleId: String) = listOf(LabelRow("l1", "Weekend", has = false))
            override suspend fun setLabel(labelId: String, titleId: String, on: Boolean) { calls += "label $labelId $on" }
        }
        rule.setContent { Shown(testGraph(api)) { WatchlistAndLabels(Title(type = "movie", id = "m1", name = "Film"), FakeNav()) } }
        rule.onNodeWithTag("watchlist").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("On my watch list").assertIsDisplayed()
        rule.onNodeWithTag("labels").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("label-l1").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("✓ Weekend").assertIsDisplayed()
        assertEquals(listOf("watch m1 true", "label l1 true"), calls)
    }

    @Test fun theWishlistShowsStatusAndLetsYouClaim() {
        val calls = mutableListOf<String>()
        val api = object : RoamApi by Unsupported {
            override suspend fun wishlist(serverId: String) = WishlistResponse(
                listOf(Wish("w1", "movie", "Heat", 1995, wants = 3), Wish("w2", "show", "Lost", onServer = OnServer("t9"))), canEdit = true,
            )
            override suspend fun wishAction(id: String, action: String) { calls += "$id $action" }
        }
        rule.setContent { Shown(testGraph(api)) { WishlistScreen("S", FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithText("3 want this").assertIsDisplayed()
        rule.onNodeWithText("On the server now").assertIsDisplayed()
        rule.onNodeWithTag("claim-w1").performClick()
        rule.waitForIdle()
        assertEquals(listOf("w1 claim"), calls)
    }

    @Test fun aRadioOpensTheFirstSongWithTheRestQueued() {
        val nav = FakeNav()
        val api = object : RoamApi by Unsupported {
            override suspend fun radio(artistId: String?, songId: String?) = RadioResult(listOf("a", "b", "c"), "Band")
        }
        rule.setContent { Shown(testGraph(api)) { RadioButton("ar1", null, nav, "radio") } }
        rule.onNodeWithTag("radio").performClick()
        rule.waitForIdle()
        assertEquals(listOf(Routes.audio("a", "Band", false, listOf("b", "c"))), nav.routes)
    }
}
