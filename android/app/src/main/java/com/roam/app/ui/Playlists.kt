package com.roam.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.roam.app.LocalGraph
import com.roam.app.data.ApiException
import com.roam.app.data.PlaylistEntry
import kotlinx.coroutines.launch

@Composable
fun PlaylistsScreen(serverId: String, nav: Nav) {
    val graph = LocalGraph.current
    val loader = rememberLoader(serverId) { graph.api.playlists(serverId) }
    LoadView(loader, nav) { lists ->
        LazyColumn(Modifier.fillMaxSize().testTag("playlists").padding(if (graph.isTv) 48.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { Text("Playlists", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground) }
            if (lists.isEmpty()) item { Text("No playlists yet. Make one on the web.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(lists, key = { it.id }) { p ->
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).focusRing().clickable { nav.open(Routes.playlist(serverId, p.id)) }.padding(14.dp).testTag("playlist-${p.id}")) {
                    Text(p.name, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
                    Text(
                        listOfNotNull("${p.itemCount} ${if (p.itemCount == 1) "item" else "items"}", p.ownerName).joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/** The ids that follow [from] in a run of episodes (what the player queues up after the first). A different kind of entry ends the run. */
fun episodeRunAfter(entries: List<PlaylistEntry>, from: Int): List<String> =
    entries.drop(from + 1).takeWhile { it.type == "episode" && it.playable }.map { it.id }

@Composable
fun PlaylistScreen(serverId: String, playlistId: String, nav: Nav) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    val entries = remember(playlistId) { mutableStateListOf<PlaylistEntry>() }
    var next by remember(playlistId) { mutableStateOf<String?>(null) }
    var more by remember(playlistId) { mutableStateOf(false) }
    var moreError by remember(playlistId) { mutableStateOf<String?>(null) }
    val loader = rememberLoader(serverId, playlistId) {
        graph.api.playlist(serverId, playlistId).also {
            entries.clear()
            entries.addAll(it.items)
            next = it.next
        }
    }
    LoadView(loader, nav) { first ->
        LazyColumn(Modifier.fillMaxSize().testTag("playlist").padding(if (graph.isTv) 48.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Text(first.playlist.name, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
                first.playlist.description?.takeIf { it.isNotBlank() }?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            val firstPlayable = entries.indexOfFirst { it.playable && it.type != "show" }
            if (firstPlayable >= 0) item {
                Button(onClick = { nav.open(openEntry(serverId, entries, firstPlayable)) }, modifier = Modifier.testTag("play-all")) { Text("Play") }
            }
            if (entries.isEmpty()) item { Text("Nothing here you can open.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(entries.size, key = { entries[it].entryId }) { i ->
                val e = entries[i]
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).focusRing()
                        .clickable(enabled = e.playable) { nav.open(openEntry(serverId, entries, i)) }.padding(12.dp).testTag("entry-${e.entryId}"),
                ) {
                    Text(e.name, color = if (e.playable) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
                    e.subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
            if (next != null) item {
                Button(
                    enabled = !more,
                    onClick = {
                        more = true
                        scope.launch {
                            try {
                                val page = graph.api.playlist(serverId, playlistId, next)
                                entries.addAll(page.items)
                                next = page.next
                                moreError = null
                            } catch (e: ApiException) {
                                moreError = if (e.status == 0) "Roam can't be reached." else e.message
                            }
                            more = false
                        }
                    },
                    modifier = Modifier.testTag("more"),
                ) { Text("Show more") }
            }
            moreError?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("more-error")) } }
        }
    }
}

/** Where an entry leads: an episode plays at once, with the episodes after it queued; anything else opens like it does elsewhere. */
fun openEntry(serverId: String, entries: List<PlaylistEntry>, index: Int): String {
    val e = entries[index]
    return if (e.type == "episode") Routes.player("episode", e.id, e.name, queue = episodeRunAfter(entries, index)) else routeFor(serverId, e.asItem())
}
