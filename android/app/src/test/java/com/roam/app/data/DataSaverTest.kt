package com.roam.app.data

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DataSaverTest {
    @Test fun theProfileDecidesUnlessTheDeviceChooses() {
        assertNull(DataSaver.param("profile", true))
        assertEquals("1", DataSaver.param("on", false))
        assertEquals("0", DataSaver.param("off", true))
    }

    @Test fun automaticFollowsTheConnectionAndLeavesItToTheProfileWhenUnknown() {
        assertEquals("1", DataSaver.param("auto", true))
        assertEquals("0", DataSaver.param("auto", false))
        assertNull(DataSaver.param("auto", null))
    }

    @Test fun aPlayRequestCarriesTheDeviceChoiceOnlyWhenThereIsOne() = runBlocking {
        val server = MockWebServer().apply { start() }
        val body = """{"durationSeconds":60,"segments":[]}"""
        server.enqueue(MockResponse().setBody(body))
        server.enqueue(MockResponse().setBody(body))
        var choice: String? = "1"
        val api = HttpRoamApi({ server.url("/").toString() }, { "rdt" }, { choice })
        api.play("title", "m1", "")
        assertEquals("/api/play/title/m1?dataSaver=1", server.takeRequest().path)
        choice = null
        api.play("title", "m1", "")
        assertEquals("/api/play/title/m1", server.takeRequest().path)
        server.shutdown()
    }
}
