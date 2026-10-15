package com.roam.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.roam.app.data.ApiException
import com.roam.app.data.DeviceStart
import com.roam.app.data.MemorySettings
import com.roam.app.data.PollResult
import com.roam.app.data.Unsupported
import com.roam.app.data.RoamApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SignInScreenTest {
    @get:Rule val rule = createComposeRule()

    private fun start(code: String = "K7M2P") = DeviceStart(code, "dev-$code", "https://roam.example/link", "https://roam.example/link?code=$code", expiresIn = 600, interval = 3)

    @Test fun showsTheCodeAndWhereToTypeIt() {
        val api = object : RoamApi by Unsupported {
            override suspend fun startDevice(label: String) = start()
            override suspend fun pollDevice(deviceCode: String) = PollResult("pending")
        }
        rule.setContent { Shown(testGraph(api, MemorySettings())) { SignInScreen(FakeNav(), onSignedIn = {}) } }
        rule.waitForIdle()
        rule.onNodeWithTag("code").assertIsDisplayed()
        rule.onNodeWithText("K7M2P").assertIsDisplayed()
        rule.onNodeWithText("go to https://roam.example/link", substring = true).assertIsDisplayed()
    }

    @Test fun savesTheTokenAndMovesOnWhenTheCodeIsApproved() {
        val settings = MemorySettings()
        var polls = 0
        var signedIn = 0
        val api = object : RoamApi by Unsupported {
            override suspend fun startDevice(label: String): DeviceStart {
                assertEquals("Test device", label)
                return start()
            }
            override suspend fun pollDevice(deviceCode: String): PollResult = if (++polls < 3) PollResult("pending") else PollResult("approved", "rdt_new", true)
        }
        rule.setContent { Shown(testGraph(api, settings)) { SignInScreen(FakeNav(), onSignedIn = { signedIn++ }) } }
        rule.mainClock.advanceTimeBy(20_000)
        rule.waitForIdle()
        assertEquals("rdt_new", settings.token)
        assertEquals(1, signedIn)
        assertTrue(polls >= 3)
    }

    @Test fun getsANewCodeWhenTheOldOneRunsOut() {
        var asked = 0
        val api = object : RoamApi by Unsupported {
            // the first code runs out at its first look; every code after that is "BBBBB"
            override suspend fun startDevice(label: String) = start(if (asked++ == 0) "AAAAA" else "BBBBB")
            override suspend fun pollDevice(deviceCode: String) = if (deviceCode.endsWith("AAAAA")) PollResult("expired") else PollResult("pending")
        }
        rule.setContent { Shown(testGraph(api, MemorySettings())) { SignInScreen(FakeNav(), onSignedIn = {}) } }
        rule.mainClock.advanceTimeBy(10_000)
        rule.waitForIdle()
        rule.onNodeWithText("BBBBB").assertIsDisplayed()
    }

    @Test fun saysSoWhenRoamCantBeReachedAndOffersAnotherTry() {
        var attempts = 0
        val api = object : RoamApi by Unsupported {
            override suspend fun startDevice(label: String): DeviceStart {
                if (++attempts == 1) throw ApiException(0, "down", "network")
                return start()
            }
            override suspend fun pollDevice(deviceCode: String) = PollResult("pending")
        }
        rule.setContent { Shown(testGraph(api, MemorySettings())) { SignInScreen(FakeNav(), onSignedIn = {}) } }
        rule.waitForIdle()
        rule.onNodeWithTag("problem").assertIsDisplayed()
        rule.onNodeWithText("Try again").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("K7M2P").assertIsDisplayed()
    }

    @Test fun aDifferentServerAddressIsSavedOnlyIfItIsHttps() {
        val settings = MemorySettings()
        val api = object : RoamApi by Unsupported {
            override suspend fun startDevice(label: String) = start()
            override suspend fun pollDevice(deviceCode: String) = PollResult("pending")
        }
        rule.setContent { Shown(testGraph(api, settings)) { SignInScreen(FakeNav(), onSignedIn = {}) } }
        rule.waitForIdle()
        rule.onNodeWithText("Change the server address").performClick()
        rule.onNodeWithTag("address").performTextInput("x")
        rule.onNodeWithText("Use this address").performClick()
        assertNull(settings.serverUrl)
        rule.onNodeWithTag("problem").assertIsDisplayed()
    }
}
