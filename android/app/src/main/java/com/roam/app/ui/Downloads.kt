package com.roam.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.roam.app.LocalGraph
import com.roam.app.data.ApiException
import com.roam.app.data.PlayManifest
import com.roam.app.player.NoReporter
import com.roam.app.player.mediaItemsFor
import kotlinx.coroutines.launch

private fun megabytes(bytes: Long) = if (bytes >= 1L shl 30) "%.1f GB".format(bytes / (1L shl 30).toDouble()) else "${bytes / (1L shl 20)} MB"

/** The Download button of a movie or episode: save it on this device, watch it be saved, play or remove the saved copy. */
@Composable
fun DownloadControl(kind: String, id: String, name: String, subtitle: String?, modifier: Modifier = Modifier) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    val active by graph.downloads.active.collectAsState()
    val state = active[graph.downloads.key(kind, id)]
    var saved by remember(kind, id, state) { mutableStateOf(graph.downloads.record(kind, id)) }
    var choosing by remember { mutableStateOf<PlayManifest?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }

    fun begin(manifest: PlayManifest) = graph.downloads.start(manifest, kind, id, name, subtitle, manifest.version)

    Column(modifier.testTag("download-$kind-$id"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        when {
            state != null && state.error == null -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Downloading ${(state.progress * 100).toInt()}%", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("download-progress"))
                TextButton(onClick = { graph.downloads.cancel(kind, id) }, modifier = Modifier.testTag("download-cancel")) { Text("Cancel") }
            }
            state?.error != null -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text(state.error, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("download-error"))
                TextButton(onClick = { graph.downloads.dismissError(kind, id) }) { Text("OK") }
            }
            saved != null -> Text("Saved on this device (${megabytes(saved!!.bytes)})", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("download-saved"))
            else -> OutlinedButton(onClick = {
                scope.launch {
                    try {
                        val m = graph.api.play(kind, id, graph.unsupportedAudio())
                        if (m.versions.size > 1) choosing = m else begin(m)
                        problem = null
                    } catch (e: ApiException) {
                        problem = if (e.status == 0) "Roam can't be reached." else e.message
                    }
                }
            }, modifier = Modifier.testTag("download")) { Text("Download") }
        }
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("download-problem")) }
    }

    choosing?.let { first ->
        AlertDialog(
            onDismissRequest = { choosing = null },
            title = { Text("Which quality to save?") },
            text = {
                Column {
                    for (v in first.versions) TextButton(onClick = {
                        choosing = null
                        scope.launch {
                            try {
                                begin(if (v.label == first.version) first else graph.api.playVersion(kind, id, graph.unsupportedAudio(), v.label))
                            } catch (e: ApiException) {
                                problem = if (e.status == 0) "Roam can't be reached." else e.message
                            }
                        }
                    }, modifier = Modifier.testTag("download-version-${v.label}")) { Text(v.name) }
                }
            },
            confirmButton = { TextButton(onClick = { choosing = null }) { Text("Cancel") } },
        )
    }
}

/** What is saved on this device: play it with no connection, or remove it. */
@Composable
fun DownloadsScreen(nav: Nav) {
    val graph = LocalGraph.current
    val active by graph.downloads.active.collectAsState()
    var version by remember { mutableStateOf(0) }
    val saved = remember(version, active) { graph.downloads.saved() }
    LazyColumn(Modifier.fillMaxSize().testTag("downloads").padding(if (graph.isTv) 48.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Text("Downloads", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground) }
        if (saved.isEmpty() && active.isEmpty()) item { Text("Nothing saved yet. Open a movie or an episode and press Download.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(active.entries.toList(), key = { "active-${it.key}" }) { (key, st) ->
            Text("$key: ${st.error ?: "downloading ${(st.progress * 100).toInt()}%"}", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        items(saved, key = { "${it.kind}-${it.id}" }) { r ->
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).focusRing().clickable { nav.open(Routes.offlinePlayer(r.kind, r.id)) }.padding(8.dp).testTag("saved-${r.id}")) {
                    Text(r.name, color = MaterialTheme.colorScheme.onSurface)
                    Text(listOfNotNull(r.subtitle, r.version, megabytes(r.bytes)).joinToString(" · "), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                }
                TextButton(onClick = { graph.downloads.remove(r.kind, r.id); version++ }, modifier = Modifier.testTag("remove-${r.id}")) { Text("Remove") }
            }
        }
    }
}

/** Plays a saved video from this device, with no connection: where you stopped isn't reported (there is nobody to tell). */
@Composable
fun OfflinePlayerScreen(kind: String, id: String, nav: Nav) {
    val graph = LocalGraph.current
    val record = remember(kind, id) { graph.downloads.record(kind, id) }
    if (record == null) {
        ErrorView("That isn't saved on this device any more.") { nav.back() }
        return
    }
    PlayerHost(
        manifest = record.manifest, items = mediaItemsFor(record.manifest, record.name), startSeconds = 0.0, kind = kind, id = id, keepsPlace = false, audioOnly = false, nav = nav,
        onFinished = { nav.back() }, onError = { nav.back() }, reporterFor = { NoReporter },
    )
}
