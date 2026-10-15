@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package com.roam.app.ui

import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.roam.app.LocalGraph
import com.roam.app.data.ApiException
import com.roam.app.data.PlayManifest
import com.roam.app.data.PlaySegment
import com.roam.app.player.ApiReporter
import com.roam.app.player.BackgroundAudio
import com.roam.app.player.ExoEngine
import com.roam.app.player.PlaybackSession
import com.roam.app.player.PlayerEngine
import com.roam.app.player.Reporter
import com.roam.app.player.locatePart
import com.roam.app.player.mediaItemsFor
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Plays a movie or an episode (or an extra): asks for what to play, and says in words why when it can't be played. */
@Composable
fun PlayerScreen(kind: String, id: String, name: String, startOver: Boolean, startAt: Double?, queue: List<String>, nav: Nav, onNext: (id: String, rest: List<String>) -> Unit) {
    val graph = LocalGraph.current
    var attempt by remember { mutableIntStateOf(0) }
    var stage by remember { mutableStateOf<Stage>(Stage.Loading) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(kind, id, attempt) {
        stage = Stage.Loading
        stage = try {
            Stage.Ready(graph.api.play(kind, id, graph.unsupportedAudio()))
        } catch (e: ApiException) {
            if (e.status == 401) { nav.signedOut(); return@LaunchedEffect }
            when {
                e.status == 423 -> Stage.Blocked(e.message, e.code == "busy")
                e.status == 0 -> Stage.Failed("Roam can't be reached. Check the network connection.")
                else -> Stage.Failed(e.message)
            }
        }
    }

    when (val s = stage) {
        Stage.Loading -> Centered { androidx.compose.material3.CircularProgressIndicator(Modifier.testTag("loading")) }
        is Stage.Failed -> Notice(s.message, nav, onRetry = { attempt++ })
        is Stage.Blocked -> Notice(
            s.message, nav,
            extra = if (s.canWait) ({
                var asked by remember { mutableStateOf(false) }
                OutlinedButton(enabled = !asked, onClick = { asked = true; scope.launch { runCatching { graph.api.watchWhenFree(id, null) } } }, modifier = Modifier.testTag("tell-me")) {
                    Text(if (asked) "You'll be told" else "Tell me when it's free")
                }
            }) else null,
        )
        is Stage.Ready -> {
            val start = when {
                startAt != null && startAt >= 0 -> startAt
                !startOver && s.manifest.resumeSeconds > 0 && s.manifest.resumeSeconds < s.manifest.durationSeconds - 30 -> s.manifest.resumeSeconds
                else -> 0.0
            }
            PlayerHost(
                manifest = s.manifest, items = mediaItemsFor(s.manifest, name), startSeconds = start, kind = kind, id = id, keepsPlace = kind != "extra", audioOnly = false, nav = nav,
                onFinished = { finished ->
                    if (finished && queue.isNotEmpty()) onNext(queue.first(), queue.drop(1)) else nav.back()
                },
                onError = { attempt++ },
            )
        }
    }
}

private sealed interface Stage {
    data object Loading : Stage
    data class Ready(val manifest: PlayManifest) : Stage
    data class Blocked(val message: String, val canWait: Boolean) : Stage
    data class Failed(val message: String) : Stage
}

@Composable
private fun Notice(message: String, nav: Nav, onRetry: (() -> Unit)? = null, extra: (@Composable () -> Unit)? = null) = Centered {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(32.dp)) {
        Text(message, color = MaterialTheme.colorScheme.onBackground, modifier = Modifier.testTag("play-message"))
        extra?.invoke()
        if (onRetry != null) Button(onClick = onRetry) { Text("Try again") }
        TextButton(onClick = nav::back, modifier = Modifier.testTag("go-back")) { Text("Go back") }
    }
}

/**
 * The player on screen, with a session watching over it. Used for video and for audiobooks (which come as the same kind of manifest).
 * [manifest] carries the timeline (and any scenes to skip); [items] are what is played, one per file.
 */
@Composable
fun PlayerHost(
    manifest: PlayManifest,
    items: List<MediaItem>,
    startSeconds: Double,
    kind: String,
    id: String,
    keepsPlace: Boolean,
    audioOnly: Boolean,
    nav: Nav,
    onFinished: (finished: Boolean) -> Unit,
    onError: () -> Unit,
    engineFor: (Player) -> PlayerEngine = { ExoEngine(it) },
    reporterFor: (() -> Reporter)? = null,
    /** Hands the files to the player and starts it (tests replace this, so no real connection is made). */
    begin: (Player, startIndex: Int, startMs: Long) -> Unit = { p, index, ms ->
        p.setMediaItems(items, index, ms)
        p.prepare()
        p.playWhenReady = true
    },
) {
    val graph = LocalGraph.current
    val context = LocalContext.current
    val player = remember(manifest) {
        ExoPlayer.Builder(context)
            // Say what is playing, so other apps' sound makes way (and a call pauses it); headphones coming out pause it; a song keeps playing with the screen off.
            .setAudioAttributes(
                AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(if (audioOnly) C.AUDIO_CONTENT_TYPE_MUSIC else C.AUDIO_CONTENT_TYPE_MOVIE).build(),
                true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
    }
    if (audioOnly) AllowNotifications()
    var failed by remember(manifest) { mutableStateOf<String?>(null) }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                failed = "This couldn't be played: ${error.errorCodeName.lowercase().replace('_', ' ')}."
            }
        }
        player.addListener(listener)
        if (audioOnly) BackgroundAudio.start(context, player)
        onDispose {
            player.removeListener(listener)
            if (audioOnly) BackgroundAudio.stop(context, player)
            player.release()
        }
    }
    val session = remember(manifest) {
        PlaybackSession(manifest, engineFor(player), reporterFor?.invoke() ?: ApiReporter(graph.api, kind, id, graph.appScope), graph.clockMs, skipInsteadOfMute = false, keepsPlace = keepsPlace)
    }
    LaunchedEffect(player) {
        val loc = locatePart(manifest.segments, startSeconds)
        begin(player, loc?.index ?: 0, ((loc?.localSeconds ?: 0.0) * 1000).toLong())
    }
    LaunchedEffect(session) {
        while (isActive) {
            if (!session.tick()) break
            delay(250)
        }
        val ui = session.ui.value
        if (ui.lostMessage == null && failed == null) onFinished(ui.finished)
    }
    DisposableEffect(session) { onDispose { session.close() } }

    val ui by session.ui.collectAsState()
    val focus = remember { FocusRequester() }
    BackHandler(enabled = ui.offer != null) { session.dismissSkip() }
    LaunchedEffect(ui.offer) { if (ui.offer != null) runCatching { focus.requestFocus() } }
    LaunchedEffect(ui.notice) {
        if (ui.notice != null) {
            delay(7000)
            session.clearNotice()
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black).testTag("player")) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    this.player = player
                    useController = true
                    controllerShowTimeoutMs = 4000
                    if (audioOnly) {
                        defaultArtwork = null
                        controllerHideOnTouch = false
                        showController()
                    }
                }
            },
            modifier = Modifier.fillMaxSize(),
        )
        ui.notice?.let {
            Text(it, color = Color.White, modifier = Modifier.align(Alignment.TopCenter).padding(24.dp).background(Color(0xAA000000)).padding(12.dp).testTag("notice"))
        }
        ui.offer?.let { offer ->
            Button(onClick = session::pressSkip, modifier = Modifier.align(Alignment.BottomEnd).padding(end = 32.dp, bottom = 96.dp).focusRequester(focus).testTag("skip")) { Text(offer.label) }
        }
    }

    ui.lostMessage?.let { message ->
        AlertDialog(
            onDismissRequest = { nav.back() },
            title = { Text("Stopped") },
            text = { Text(message, modifier = Modifier.testTag("lost")) },
            confirmButton = { TextButton(onClick = { nav.back() }) { Text("OK") } },
        )
    }
    failed?.let { message ->
        AlertDialog(
            onDismissRequest = { nav.back() },
            title = { Text("Couldn't play it") },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = onError) { Text("Try again") } },
            dismissButton = { TextButton(onClick = { nav.back() }) { Text("Go back") } },
        )
    }
}

/** Asks (once, on Android 13 and later) for the right to show the notification that has the play and pause buttons. Listening works without it, just without the notification. */
@Composable
private fun AllowNotifications() {
    if (android.os.Build.VERSION.SDK_INT < 33) return
    val context = LocalContext.current
    val ask = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        if (androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            runCatching { ask.launch(android.Manifest.permission.POST_NOTIFICATIONS) }
        }
    }
}

/** An audiobook's parts, or one song, as the timeline a session works with. */
fun audioManifest(durationSeconds: Double, segments: List<Pair<Double, Double>>, urls: List<String>, heartbeat: Boolean): Pair<PlayManifest, List<MediaItem>> {
    val parts = segments.mapIndexed { i, (start, duration) -> PlaySegment(index = i, url = urls[i], durationSeconds = duration, startSeconds = start) }
    return PlayManifest(heartbeat = heartbeat, durationSeconds = durationSeconds, segments = parts) to urls.map { MediaItem.fromUri(it) }
}
