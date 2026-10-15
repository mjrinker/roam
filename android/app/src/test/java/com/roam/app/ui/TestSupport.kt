package com.roam.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import com.roam.app.AppGraph
import com.roam.app.LocalGraph
import com.roam.app.data.MemorySettings
import com.roam.app.data.RoamApi
import com.roam.app.data.Settings

class FakeNav : Nav {
    val routes = mutableListOf<String>()
    var backs = 0
    var signedOuts = 0
    override fun open(route: String) {
        routes += route
    }
    override fun back() {
        backs++
    }
    override fun signedOut() {
        signedOuts++
    }
}

fun testGraph(api: RoamApi, settings: Settings = MemorySettings(token = "rdt_test"), tv: Boolean = false) = AppGraph(settings, api, isTv = tv, deviceName = "Test device")

@Composable
fun Shown(graph: AppGraph, content: @Composable () -> Unit) = CompositionLocalProvider(LocalGraph provides graph) { RoamTheme { content() } }

/** A player that does what a test tells it to. */
class FakeEngine : com.roam.app.player.PlayerEngine {
    var playing = true
    var paused = false
    var item = 0
    var position = 0.0
    val log = mutableListOf<String>()
    override val isPlaying get() = playing
    override val isPaused get() = paused
    override val itemIndex get() = item
    override val positionSeconds get() = position
    override fun seekInItem(seconds: Double) {
        log += "seek $seconds"
        position = seconds
    }
    override fun gotoItem(index: Int, seconds: Double) {
        log += "item $index $seconds"
        item = index
        position = seconds
    }
    override fun stop() {
        log += "stop"
        playing = false
    }
    override fun setMuted(muted: Boolean) {
        log += "mute $muted"
    }
}

class FakeReporter : com.roam.app.player.Reporter {
    val saves = mutableListOf<Triple<Int, Int, Boolean>>()
    var beats = 0
    var ended = 0
    var lose: String? = null
    override fun saveProgress(positionSeconds: Int, durationSeconds: Int, finished: Boolean) {
        saves += Triple(positionSeconds, durationSeconds, finished)
    }
    override fun beat(paused: Boolean, onLost: (String) -> Unit) {
        beats++
        lose?.let(onLost)
    }
    override fun end() {
        ended++
    }
}
