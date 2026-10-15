package com.roam.app

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.roam.app.data.DeviceStart
import com.roam.app.data.MemorySettings
import com.roam.app.data.PollResult
import com.roam.app.data.RoamApi
import com.roam.app.data.Unsupported
import com.roam.app.ui.RoamApp
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The whole app on a real Android: it opens on the sign-in screen with a code when nobody is signed in. */
@RunWith(AndroidJUnit4::class)
class LaunchInstrumentedTest {
    @get:Rule val rule = createComposeRule()

    @Test fun opensOnTheSignInCode() {
        val api = object : RoamApi by Unsupported {
            override suspend fun startDevice(label: String) = DeviceStart("K7M2P", "dev", "https://roam.example/link")
            override suspend fun pollDevice(deviceCode: String) = PollResult("pending")
        }
        val graph = AppGraph(MemorySettings(), api, isTv = false)
        rule.setContent { CompositionLocalProvider(LocalGraph provides graph) { RoamApp() } }
        rule.waitUntil(timeoutMillis = 20_000) { rule.onAllNodesWithTagCount("code") > 0 }
        rule.onNodeWithTag("code").assertIsDisplayed()
    }
}

private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithTagCount(tag: String) = onAllNodes(androidx.compose.ui.test.hasTestTag(tag)).fetchSemanticsNodes().size
