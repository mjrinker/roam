package com.roam.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import com.roam.app.data.Account
import com.roam.app.data.DeviceRow
import com.roam.app.data.MemorySettings
import com.roam.app.data.Me
import com.roam.app.data.NotificationItem
import com.roam.app.data.NotificationsResponse
import com.roam.app.data.ProfileSummary
import com.roam.app.data.RoamApi
import com.roam.app.data.Unsupported
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// A tall, wide screen, so whole lists are on it (a list only builds the rows that are in view).
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w1200dp-h3000dp-xhdpi")
class AccountScreenTest {
    @get:Rule val rule = createComposeRule()

    private fun api(onSignOut: () -> Unit = {}, onDeviceOut: (String) -> Unit = {}) = object : RoamApi by Unsupported {
        override suspend fun me() = Me(Account("a", "ann@example.com"), ProfileSummary("p", "Ann"), listOf(ProfileSummary("p", "Ann")))
        override suspend fun devices() = listOf(DeviceRow("d1", "This TV", current = true), DeviceRow("d2", "Old phone"))
        override suspend fun signOut() = onSignOut()
        override suspend fun signOutDevice(id: String) = onDeviceOut(id)
    }

    @Test fun showsWhoAndWhichDevicesAndSignsAnotherOut() {
        val out = mutableListOf<String>()
        rule.setContent { Shown(testGraph(api(onDeviceOut = { out += it }))) { AccountScreen(FakeNav(), onSwitchProfile = {}) } }
        rule.waitForIdle()
        rule.onNodeWithText("ann@example.com").assertIsDisplayed()
        rule.onNodeWithText("Watching as Ann").assertIsDisplayed()
        rule.onNodeWithText("This TV  (this device)").assertIsDisplayed()
        rule.onNodeWithTag("sign-out-d2").performScrollTo().performClick()
        rule.waitForIdle()
        assertEquals(listOf("d2"), out)
    }

    @Test fun signingOutTellsRoamClearsTheSavedSignInAndGoesToSignIn() {
        val settings = MemorySettings(token = "rdt_x", serverId = "S")
        var told = 0
        val nav = FakeNav()
        rule.setContent { Shown(testGraph(api(onSignOut = { told++ }), settings)) { AccountScreen(nav, onSwitchProfile = {}) } }
        rule.waitForIdle()
        rule.onNodeWithTag("sign-out").performScrollTo().performClick()
        rule.waitForIdle()
        assertEquals(1, told)
        assertNull(settings.token)
        assertNull(settings.serverId)
        assertEquals(1, nav.signedOuts)
    }

    @Test fun switchingProfileIsLeftToTheCaller() {
        var switched = 0
        rule.setContent { Shown(testGraph(api())) { AccountScreen(FakeNav(), onSwitchProfile = { switched++ }) } }
        rule.waitForIdle()
        rule.onNodeWithTag("switch-profile").performClick()
        assertEquals(1, switched)
    }

    @Test fun anotherServerAddressSignsYouOutOfTheOldOne() {
        val settings = MemorySettings(token = "rdt_x")
        val nav = FakeNav()
        rule.setContent { Shown(testGraph(api(), settings)) { AccountScreen(nav, onSwitchProfile = {}) } }
        rule.waitForIdle()
        rule.onNodeWithTag("server-address").performScrollTo().performTextClearance()
        rule.onNodeWithTag("server-address").performTextInput("https://roam.example")
        rule.onNodeWithText("Use this address (signs you out)").performScrollTo().performClick()
        assertEquals("https://roam.example", settings.serverUrl)
        assertNull(settings.token)
        assertEquals(1, nav.signedOuts)
    }

    @Test fun anAddressWithoutHttpsIsRefused() {
        val settings = MemorySettings(token = "rdt_x")
        rule.setContent { Shown(testGraph(api(), settings)) { AccountScreen(FakeNav(), onSwitchProfile = {}) } }
        rule.waitForIdle()
        rule.onNodeWithTag("server-address").performScrollTo().performTextClearance()
        rule.onNodeWithTag("server-address").performTextInput("http://roam.example")
        rule.onNodeWithText("Use this address (signs you out)").performScrollTo().performClick()
        rule.onNodeWithText("The address has to start with https://").assertIsDisplayed()
        assertEquals("rdt_x", settings.token)
    }

    @Test fun notificationsAreListedAndMarkedRead() {
        var marked = 0
        val api = object : RoamApi by Unsupported {
            override suspend fun notifications() = NotificationsResponse(1, listOf(NotificationItem("n1", "available", "“The Film” is free to watch now.")))
            override suspend fun markNotificationsRead() {
                marked++
            }
        }
        rule.setContent { Shown(testGraph(api)) { NotificationsScreen(FakeNav()) } }
        rule.waitForIdle()
        rule.onNodeWithText("“The Film” is free to watch now.").assertIsDisplayed()
        assertEquals(1, marked)
    }

    @Test fun aDeviceCanBeSetToFollowTheConnectionForDataSaver() {
        val settings = MemorySettings(token = "rdt_test")
        rule.setContent { Shown(testGraph(api(), settings)) { AccountScreen(FakeNav(), onSwitchProfile = {}) } }
        rule.waitForIdle()
        assertEquals("profile", settings.dataSaverMode)
        rule.onNodeWithTag("saver-auto").performScrollTo().performClick()
        assertEquals("auto", settings.dataSaverMode)
        rule.onNodeWithTag("saver-off").performScrollTo().performClick()
        assertEquals("off", settings.dataSaverMode)
    }
}
