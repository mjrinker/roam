package com.roam.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.roam.app.data.Account
import com.roam.app.data.ApiException
import com.roam.app.data.MemorySettings
import com.roam.app.data.Me
import com.roam.app.data.ProfileSummary
import com.roam.app.data.RoamApi
import com.roam.app.data.ServerSummary
import com.roam.app.data.Unsupported
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class GateScreenTest {
    @get:Rule val rule = createComposeRule()

    private val ann = ProfileSummary("p1", "Ann", role = "owner", selected = true)
    private val dad = ProfileSummary("p2", "Dad", role = "admin", hasPin = true)
    private val kid = ProfileSummary("p3", "Kid", role = "limited")
    private fun me(selected: ProfileSummary?, vararg all: ProfileSummary) = Me(Account("a"), selected, all.toList())

    @Test fun goesStraightToTheServerWhenAProfileIsAlreadyChosen() {
        val settings = MemorySettings(token = "t")
        var ready: String? = null
        val api = object : RoamApi by Unsupported {
            override suspend fun me() = me(ann, ann)
            override suspend fun servers() = listOf(ServerSummary("S", "Home"))
        }
        rule.setContent { Shown(testGraph(api, settings)) { GateScreen(FakeNav(), force = false, onReady = { ready = it }) } }
        rule.waitForIdle()
        assertEquals("S", ready)
        assertEquals("S", settings.serverId)
    }

    @Test fun asksWhoIsWatchingAndWaitsForAPinWhenThereIsOne() {
        val chosen = mutableListOf<Pair<String, String?>>()
        val api = object : RoamApi by Unsupported {
            override suspend fun me() = me(null, ann, dad)
            override suspend fun chooseProfile(viewerId: String, pin: String?) {
                chosen += viewerId to pin
                if (pin == "0000") throw ApiException(401, "Incorrect PIN", "incorrect_pin")
            }
            override suspend fun servers() = listOf(ServerSummary("S", "Home"))
        }
        var ready: String? = null
        rule.setContent { Shown(testGraph(api)) { GateScreen(FakeNav(), force = false, onReady = { ready = it }) } }
        rule.waitForIdle()
        rule.onNodeWithText("Who's watching?").assertIsDisplayed()
        rule.onNodeWithTag("profile-p2").performClick()
        rule.onNodeWithTag("pin").performTextInput("0000")
        rule.onNodeWithText("OK").performClick()
        rule.waitForIdle()
        rule.onNodeWithTag("pin-problem").assertIsDisplayed()
        assertNull(ready)
        rule.onNodeWithTag("pin").performTextInput("1234") // adds to what is there, but only up to four digits
        assertEquals(listOf("p2" to "0000"), chosen)
    }

    @Test fun aProfileWithoutAPinIsChosenAtOnce() {
        val chosen = mutableListOf<Pair<String, String?>>()
        val api = object : RoamApi by Unsupported {
            override suspend fun me() = me(null, ann, kid)
            override suspend fun chooseProfile(viewerId: String, pin: String?) {
                chosen += viewerId to pin
            }
            override suspend fun servers() = listOf(ServerSummary("S", "Home"))
        }
        var ready: String? = null
        rule.setContent { Shown(testGraph(api)) { GateScreen(FakeNav(), force = false, onReady = { ready = it }) } }
        rule.waitForIdle()
        rule.onNodeWithTag("profile-p3").performClick()
        rule.waitForIdle()
        assertEquals(listOf("p3" to null), chosen)
        assertEquals("S", ready)
    }

    @Test fun asksWhichServerWhenThereAreSeveralAndRemembersTheChoice() {
        val settings = MemorySettings(token = "t")
        val api = object : RoamApi by Unsupported {
            override suspend fun me() = me(ann, ann)
            override suspend fun servers() = listOf(ServerSummary("S1", "Home"), ServerSummary("S2", "Office"))
        }
        var ready: String? = null
        rule.setContent { Shown(testGraph(api, settings)) { GateScreen(FakeNav(), force = false, onReady = { ready = it }) } }
        rule.waitForIdle()
        rule.onNodeWithText("Choose a server").assertIsDisplayed()
        rule.onNodeWithTag("server-S2").performClick()
        assertEquals("S2", ready)
        assertEquals("S2", settings.serverId)
    }

    @Test fun usesTheSavedServerWithoutAsking() {
        val settings = MemorySettings(token = "t", serverId = "S2")
        val api = object : RoamApi by Unsupported {
            override suspend fun me() = me(ann, ann)
            override suspend fun servers() = listOf(ServerSummary("S1", "Home"), ServerSummary("S2", "Office"))
        }
        var ready: String? = null
        rule.setContent { Shown(testGraph(api, settings)) { GateScreen(FakeNav(), force = false, onReady = { ready = it }) } }
        rule.waitForIdle()
        assertEquals("S2", ready)
    }

    @Test fun forcedProfileChoiceAsksEvenWhenOneIsChosen() {
        val api = object : RoamApi by Unsupported {
            override suspend fun me() = me(ann, ann, kid)
        }
        rule.setContent { Shown(testGraph(api)) { GateScreen(FakeNav(), force = true, onReady = {}) } }
        rule.waitForIdle()
        rule.onNodeWithText("Who's watching?").assertIsDisplayed()
    }

    @Test fun aRefusedSignInGoesToSignIn() {
        val nav = FakeNav()
        val api = object : RoamApi by Unsupported {
            override suspend fun me(): Me = throw ApiException(401, "Sign in required", "unauthorized")
        }
        rule.setContent { Shown(testGraph(api)) { GateScreen(nav, force = false, onReady = {}) } }
        rule.waitForIdle()
        assertEquals(1, nav.signedOuts)
    }

    @Test fun noServersIsExplained() {
        val api = object : RoamApi by Unsupported {
            override suspend fun me() = me(ann, ann)
            override suspend fun servers() = emptyList<ServerSummary>()
        }
        rule.setContent { Shown(testGraph(api)) { GateScreen(FakeNav(), force = false, onReady = {}) } }
        rule.waitForIdle()
        rule.onNodeWithText("You're not in any servers yet", substring = true).assertIsDisplayed()
    }
}
