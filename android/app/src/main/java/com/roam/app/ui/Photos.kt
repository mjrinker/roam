package com.roam.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.roam.app.LocalGraph
import com.roam.app.data.ApiException
import com.roam.app.data.PhotoRef
import com.roam.app.data.PhotoView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** How long a picture stays up in a slideshow. */
const val SLIDESHOW_MS = 6000L

/**
 * One picture, large, with the ones either side of it. Left and right (a remote's arrows, the buttons, or Previous/Next) move through the
 * pictures in the order of the place it was opened from; a clip in between opens in the video player. Slideshow goes on by itself.
 */
@Composable
fun PhotoScreen(serverId: String, firstId: String, from: String, nav: Nav, slideshowMs: Long = SLIDESHOW_MS) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    var id by remember { mutableStateOf(firstId) }
    var playing by remember { mutableStateOf(false) }
    var favorite by remember(id) { mutableStateOf<Boolean?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    val loader = rememberLoader(serverId, id) { graph.api.photo(serverId, id, from) }
    val focus = remember { FocusRequester() }

    fun go(ref: PhotoRef?) {
        if (ref == null) return
        if (ref.type == "clip") {
            playing = false
            nav.open(Routes.player("title", ref.id, ""))
        } else id = ref.id
    }

    LoadView(loader, nav) { photo ->
        LaunchedEffect(photo.id, playing) {
            if (playing) {
                delay(slideshowMs)
                if (photo.next?.type == "photo") id = photo.next.id else playing = false // a slideshow stops at the end and at a clip
            }
        }
        LaunchedEffect(photo.id) { runCatching { focus.requestFocus() } }
        Box(
            Modifier.fillMaxSize().background(Color.Black).testTag("photo").focusRequester(focus).focusable().onKeyEvent { e ->
                if (e.type != KeyEventType.KeyDown) false
                else when (e.key) {
                    Key.DirectionRight -> { go(photo.next); true }
                    Key.DirectionLeft -> { go(photo.prev); true }
                    else -> false
                }
            },
        ) {
            AsyncImage(model = photo.imagePath, contentDescription = photo.name, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize().testTag("picture"))
            PhotoBar(photo, favorite ?: photo.favorite, playing, problem,
                onPrev = { go(photo.prev) }, onNext = { go(photo.next) }, onSlideshow = { playing = !playing },
                onFavorite = {
                    val want = !(favorite ?: photo.favorite)
                    scope.launch {
                        try {
                            graph.api.setFavorite(photo.id, want)
                            favorite = want
                            problem = null
                        } catch (e: ApiException) {
                            if (e.status == 401) nav.signedOut() else problem = if (e.status == 0) "Roam can't be reached." else e.message
                        }
                    }
                },
                onBack = nav::back,
            )
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.BoxScope.PhotoBar(
    photo: PhotoView, favorite: Boolean, playing: Boolean, problem: String?,
    onPrev: () -> Unit, onNext: () -> Unit, onSlideshow: () -> Unit, onFavorite: () -> Unit, onBack: () -> Unit,
) {
    androidx.compose.foundation.layout.Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color(0x99000000)).padding(8.dp)) {
        Text(
            listOfNotNull(photo.name, photo.takenAt?.take(10)).joinToString("  ·  "), color = Color.White, style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(horizontal = 8.dp).testTag("caption"),
        )
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 8.dp).testTag("photo-problem")) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            TextButton(onClick = onBack, modifier = Modifier.testTag("photo-back")) { Text("Back") }
            TextButton(onClick = onPrev, enabled = photo.prev != null, modifier = Modifier.testTag("photo-prev")) { Text("Previous") }
            TextButton(onClick = onSlideshow, modifier = Modifier.testTag("slideshow")) { Text(if (playing) "Stop slideshow" else "Slideshow") }
            TextButton(onClick = onFavorite, modifier = Modifier.testTag("favorite")) { Text(if (favorite) "★ Favourite" else "☆ Favourite") }
            TextButton(onClick = onNext, enabled = photo.next != null, modifier = Modifier.testTag("photo-next")) { Text("Next") }
        }
    }
}
