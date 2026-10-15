package com.roam.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.roam.app.data.ApiException
import com.roam.app.data.ApiItem

/** Where a screen can send the person. (The real one is the navigation graph; tests use a recording one.) */
interface Nav {
    fun open(route: String)
    fun back()
    /** The sign-in was refused (it ran out or was revoked): go to the sign-in screen. */
    fun signedOut()
}

sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Ready<T>(val value: T) : Load<T>
    data class Failed(val error: ApiException) : Load<Nothing>
}

class Loader<T>(val state: State<Load<T>>, val reload: () -> Unit)

/** Runs [block] when the screen opens (and again when a key changes or [Loader.reload] is called). */
@Composable
fun <T> rememberLoader(vararg keys: Any?, block: suspend () -> T): Loader<T> {
    var attempt by remember { mutableIntStateOf(0) }
    val state = produceState<Load<T>>(Load.Loading, *keys, attempt) {
        value = Load.Loading
        value = try {
            Load.Ready(block())
        } catch (e: ApiException) {
            Load.Failed(e)
        }
    }
    return Loader(state) { attempt++ }
}

/** Spinner while loading, words and a Try again button when it failed, and the content when it's there. A refused sign-in goes to sign-in. */
@Composable
fun <T> LoadView(loader: Loader<T>, nav: Nav, content: @Composable (T) -> Unit) {
    when (val s = loader.state.value) {
        Load.Loading -> Centered { CircularProgressIndicator(modifier = Modifier.testTag("loading")) }
        is Load.Failed -> {
            if (s.error.status == 401) {
                LaunchedEffect(Unit) { nav.signedOut() }
            } else {
                ErrorView(if (s.error.status == 0) "Roam can't be reached. Check the network connection." else s.error.message, loader.reload)
            }
        }
        is Load.Ready -> content(s.value)
    }
}

@Composable
fun Centered(content: @Composable () -> Unit) = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }

@Composable
fun ErrorView(message: String, onRetry: () -> Unit) = Centered {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp), modifier = Modifier.padding(32.dp)) {
        Text(message, color = MaterialTheme.colorScheme.onBackground, modifier = Modifier.testTag("error"))
        Button(onClick = onRetry) { Text("Try again") }
    }
}

/** A ring around whatever has focus (a remote's highlight; a touch screen never shows it). */
fun Modifier.focusRing(shape: androidx.compose.ui.graphics.Shape = RoundedCornerShape(10.dp)): Modifier = composed {
    var focused by remember { mutableStateOf(false) }
    this.onFocusChanged { focused = it.isFocused }.border(if (focused) 3.dp else 0.dp, if (focused) Accent else androidx.compose.ui.graphics.Color.Transparent, shape)
}

@Composable
fun PosterCard(item: ApiItem, onClick: () -> Unit, width: Dp = 150.dp, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(10.dp)
    Column(modifier.width(width).focusRing(shape).clip(shape).clickable(onClick = onClick).testTag("card-${item.id}").padding(bottom = 4.dp)) {
        Box(Modifier.fillMaxWidth().aspectRatio(if (item.square) 1f else 2f / 3f).clip(shape).background(MaterialTheme.colorScheme.surfaceVariant)) {
            AsyncImage(model = item.posterUrl, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            val progress = item.progress
            if (progress != null && progress > 0) {
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(5.dp).background(androidx.compose.ui.graphics.Color(0x66000000))) {
                    Box(Modifier.fillMaxWidth(progress.toFloat().coerceIn(0f, 1f)).height(5.dp).background(Accent))
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(item.name, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onBackground, modifier = Modifier.padding(horizontal = 2.dp))
        item.subtitle?.let { Text(it, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 2.dp)) }
    }
}

/** The route that opens an item of a list. */
fun routeFor(serverId: String, item: ApiItem): String = when (item.type) {
    "movie", "show", "audiobook" -> Routes.title(serverId, item.id)
    "episode" -> Routes.player("episode", item.id, item.name)
    "album" -> Routes.album(serverId, item.id)
    "artist" -> Routes.artist(serverId, item.id)
    "audio" -> Routes.audio(item.id, item.name, remember = false)
    "clip" -> Routes.player("title", item.id, item.name)
    else -> Routes.home(serverId)
}
