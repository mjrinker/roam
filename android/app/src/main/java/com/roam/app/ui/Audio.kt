package com.roam.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.media3.common.MediaItem
import com.roam.app.LocalGraph
import com.roam.app.data.ApiException
import com.roam.app.data.PlayManifest

private sealed interface AudioStage {
    data object Loading : AudioStage
    data class Ready(val manifest: PlayManifest, val items: List<MediaItem>, val start: Double) : AudioStage
    data class Failed(val message: String, val signedOut: Boolean = false) : AudioStage
}

/** A song or an audiobook. An audiobook keeps its place; a song doesn't. */
@Composable
fun AudioScreen(id: String, name: String, remember: Boolean, nav: Nav) {
    val graph = LocalGraph.current
    var attempt by remember { mutableIntStateOf(0) }
    var stage by remember { mutableStateOf<AudioStage>(AudioStage.Loading) }
    LaunchedEffect(id, attempt) {
        stage = AudioStage.Loading
        stage = try {
            val m = graph.api.audiobook(id)
            val urls = m.segments.map { seg -> m.urls.firstOrNull { it.index == seg.index }?.url ?: graph.api.audiobookSegmentUrl(id, seg.index) }
            val (manifest, items) = audioManifest(m.durationSeconds, m.segments.map { it.startSeconds to it.durationSeconds }, urls, m.heartbeat)
            val start = if (remember && m.resumeSeconds > 0 && m.resumeSeconds < m.durationSeconds - 30) m.resumeSeconds else 0.0
            AudioStage.Ready(manifest, items.map { it.buildUpon().setMediaMetadata(androidx.media3.common.MediaMetadata.Builder().setTitle(name).build()).build() }, start)
        } catch (e: ApiException) {
            if (e.status == 401) AudioStage.Failed("", signedOut = true)
            else AudioStage.Failed(if (e.status == 0) "Roam can't be reached. Check the network connection." else e.message)
        }
    }
    when (val s = stage) {
        AudioStage.Loading -> Centered { androidx.compose.material3.CircularProgressIndicator(Modifier.testTag("loading")) }
        is AudioStage.Failed -> if (s.signedOut) LaunchedEffect(Unit) { nav.signedOut() } else ErrorView(s.message) { attempt++ }
        is AudioStage.Ready -> PlayerHost(
            manifest = s.manifest, items = s.items, startSeconds = s.start, kind = "title", id = id, keepsPlace = remember, audioOnly = true, nav = nav,
            onFinished = { nav.back() }, onError = { attempt++ },
        )
    }
}
