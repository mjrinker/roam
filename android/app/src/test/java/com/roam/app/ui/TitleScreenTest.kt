package com.roam.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.roam.app.data.CastMember
import com.roam.app.data.Chapter
import com.roam.app.data.Episode
import com.roam.app.data.ExtraGroup
import com.roam.app.data.ExtraItem
import com.roam.app.data.Guide
import com.roam.app.data.GuideLine
import com.roam.app.data.Ownership
import com.roam.app.data.OwnershipUnit
import com.roam.app.data.Resume
import com.roam.app.data.RoamApi
import com.roam.app.data.Title
import com.roam.app.data.Unsupported
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// A tall, wide screen, so whole lists are on it (a list only builds the rows that are in view).
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w1200dp-h3000dp-xhdpi")
class TitleScreenTest {
    @get:Rule val rule = createComposeRule()

    private fun movie(resume: Resume? = null, fromCommunity: Boolean = false) = Title(
        type = "movie", id = "m1", name = "The Film", year = 2001, runtimeSeconds = 5400, certification = "PG", overview = "A story.", resume = resume,
        chapters = listOf(Chapter("One", 0.0), Chapter("Two", 2000.0)),
        guide = Guide(listOf(GuideLine("violence", "high", 1, 20, "file", skippedForYou = true)), fromCommunity = fromCommunity),
        extras = listOf(ExtraGroup("trailers", listOf(ExtraItem("x1", "Teaser", 90.0, "/api/play/extra/x1")))),
        cast = listOf(CastMember("Ann Actor", "The Hero")),
        ownership = Ownership("review", true, listOf(OwnershipUnit(iOwn = true, myShared = false))),
    )

    private fun apiFor(t: Title) = object : RoamApi by Unsupported {
        override suspend fun title(serverId: String, id: String, season: Int?) = t
    }

    @Test fun aMovieShowsItsFactsAndPlaysFromTheStart() {
        val nav = FakeNav()
        rule.setContent { Shown(testGraph(apiFor(movie()))) { TitleScreen("S", "m1", nav) } }
        rule.waitForIdle()
        rule.onNodeWithTag("title-name").assertIsDisplayed()
        rule.onNodeWithText("2001  ·  1:30:00  ·  PG").assertIsDisplayed()
        rule.onNodeWithTag("play").performClick()
        assertEquals(listOf(Routes.player("title", "m1", "The Film")), nav.routes)
        assertEquals(0, rule.onAllNodesWithTag("start-over").fetchSemanticsNodes().size)
    }

    @Test fun aMovieInProgressOffersResumeAndStartOver() {
        val nav = FakeNav()
        rule.setContent { Shown(testGraph(apiFor(movie(Resume(1800.0, 5400.0))))) { TitleScreen("S", "m1", nav) } }
        rule.waitForIdle()
        rule.onNodeWithText("Resume from 30:00").assertIsDisplayed()
        rule.onNodeWithTag("start-over").performClick()
        assertEquals(listOf(Routes.player("title", "m1", "The Film", startOver = true)), nav.routes)
    }

    @Test fun chaptersOpenTheMovieAtThatMoment() {
        val nav = FakeNav()
        rule.setContent { Shown(testGraph(apiFor(movie()))) { TitleScreen("S", "m1", nav) } }
        rule.waitForIdle()
        rule.onNodeWithTag("chapter-2000").performScrollTo().performClick()
        assertEquals(listOf(Routes.player("title", "m1", "The Film", startAt = 2000.0)), nav.routes)
    }

    @Test fun extrasPlayAsExtras() {
        val nav = FakeNav()
        rule.setContent { Shown(testGraph(apiFor(movie()))) { TitleScreen("S", "m1", nav) } }
        rule.waitForIdle()
        rule.onNodeWithTag("extra-x1").performScrollTo().performClick()
        assertEquals(listOf(Routes.player("extra", "x1", "Teaser")), nav.routes)
    }

    @Test fun theParentalGuideAndOwnershipAreShown() {
        rule.setContent { Shown(testGraph(apiFor(movie()))) { TitleScreen("S", "m1", FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithTag("guide-line").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Violence · high — 1 scene, 20 sec · skipped for you").assertIsDisplayed()
        rule.onNodeWithTag("ownership-line").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("you own it, and have withdrawn your copy").assertIsDisplayed()
    }

    @Test fun theCommunityCreditAndWarningAppearOnlyWhenItsDataDoes() {
        rule.setContent { Shown(testGraph(apiFor(movie(fromCommunity = false)))) { TitleScreen("S", "m1", FakeNav()) } }
        rule.waitForIdle()
        assertEquals(0, rule.onAllNodesWithTag("ddd-credit").fetchSemanticsNodes().size)
    }

    @Test fun theCommunityCreditAndWarningAppearWithTheirData() {
        rule.setContent { Shown(testGraph(apiFor(movie(fromCommunity = true)))) { TitleScreen("S", "m1", FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithTag("ddd-credit").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Powered by DoesTheDogDie.com", substring = true).assertIsDisplayed()
        rule.onNodeWithText("aren't verified", substring = true).assertIsDisplayed()
    }

    // ── shows ──
    private fun show(season: Int) = Title(
        type = "show", id = "s1", name = "The Show", seasons = listOf(1, 2), season = season, continueEpisodeId = "e2",
        episodes = listOf(
            Episode("e1", 1, "Pilot", watched = true), Episode("e2", 2, null, inProgress = true), Episode("e3", 3, "Three"),
        ),
    )

    @Test fun aShowListsItsEpisodesAndPlaysOneWithTheRestQueued() {
        val nav = FakeNav()
        val api = object : RoamApi by Unsupported {
            override suspend fun title(serverId: String, id: String, season: Int?) = show(season ?: 1)
        }
        rule.setContent { Shown(testGraph(api)) { TitleScreen("S", "s1", nav) } }
        rule.waitForIdle()
        rule.onNodeWithText("1. Pilot").assertIsDisplayed()
        rule.onNodeWithText("2. Episode 2").assertIsDisplayed()
        rule.onNodeWithText("Watched").assertIsDisplayed()
        rule.onNodeWithText("In progress").assertIsDisplayed()
        rule.onNodeWithTag("episode-e1").performClick()
        rule.onNodeWithTag("play").performClick()
        assertEquals(
            listOf(Routes.player("episode", "e1", "The Show", queue = listOf("e2", "e3")), Routes.player("episode", "e2", "The Show", queue = listOf("e3"))),
            nav.routes,
        )
        rule.onNodeWithText("Resume next episode").assertIsDisplayed()
    }

    @Test fun changingSeasonAsksForThatSeason() {
        val asked = mutableListOf<Int?>()
        val api = object : RoamApi by Unsupported {
            override suspend fun title(serverId: String, id: String, season: Int?): Title {
                asked += season
                return show(season ?: 1)
            }
        }
        rule.setContent { Shown(testGraph(api)) { TitleScreen("S", "s1", FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithTag("season-2").performClick()
        rule.waitForIdle()
        assertEquals(listOf<Int?>(null, 2), asked)
    }

    @Test fun anAudiobookListensAndResumes() {
        val nav = FakeNav()
        val book = Title(type = "audiobook", id = "b1", name = "A Book", authors = listOf("Ann Author"), narrators = listOf("Ned"), resume = Resume(4000.0, 7200.0))
        rule.setContent { Shown(testGraph(apiFor(book))) { TitleScreen("S", "b1", nav) } }
        rule.waitForIdle()
        rule.onNodeWithText("Read by Ned").assertIsDisplayed()
        rule.onNodeWithTag("play").performClick()
        assertEquals(listOf(Routes.audio("b1", "A Book", remember = true)), nav.routes)
        rule.onNodeWithText("Resume from 1:06:40").assertIsDisplayed()
    }
}
