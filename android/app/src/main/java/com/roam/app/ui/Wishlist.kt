package com.roam.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.roam.app.LocalGraph
import com.roam.app.data.ApiException
import com.roam.app.data.Wish
import com.roam.app.data.WishHit
import kotlinx.coroutines.launch

private val KINDS = listOf("movie" to "Movie", "show" to "TV show", "audiobook" to "Audiobook", "album" to "Album", "book" to "Book", "other" to "Other")

private fun statusLine(w: Wish): String = when {
    w.onServer != null -> "On the server now"
    w.status == "got" -> "Got it"
    w.status == "claimed" -> if (w.claimedByMe) "You're getting this" else "${w.claimedByName ?: "Someone"} is getting this"
    else -> "${w.wants} want${if (w.wants == 1) "s" else ""} this"
}

/** What the household that buys media could get next: everyone sees the list, says what they'd like, and the buyer says "I'll get this". */
@Composable
fun WishlistScreen(serverId: String, nav: Nav) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    val loader = rememberLoader(serverId) { graph.api.wishlist(serverId) }
    var note by remember { mutableStateOf<String?>(null) }
    var kind by remember { mutableStateOf("movie") }
    var text by remember { mutableStateOf("") }
    var hits by remember { mutableStateOf<List<WishHit>?>(null) }
    fun run(block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
                note = null
                loader.reload()
            } catch (e: ApiException) {
                if (e.status == 401) nav.signedOut() else note = if (e.status == 0) "Roam can't be reached." else e.message
            }
        }
    }
    LoadView(loader, nav) { list ->
        LazyColumn(Modifier.fillMaxSize().testTag("wishlist-page").padding(if (graph.isTv) 48.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { Text("Wishlist", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground) }
            note?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("wishlist-note")) } }
            if (list.canEdit) {
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            for ((k, label) in KINDS.take(3)) {
                                if (k == kind) Button(onClick = { kind = k }, modifier = Modifier.testTag("kind-$k")) { Text(label) }
                                else OutlinedButton(onClick = { kind = k }, modifier = Modifier.testTag("kind-$k")) { Text(label) }
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            for ((k, label) in KINDS.drop(3)) {
                                if (k == kind) Button(onClick = { kind = k }, modifier = Modifier.testTag("kind-$k")) { Text(label) }
                                else OutlinedButton(onClick = { kind = k }, modifier = Modifier.testTag("kind-$k")) { Text(label) }
                            }
                        }
                        OutlinedTextField(value = text, onValueChange = { text = it; hits = null }, singleLine = true, label = { Text("What would you like?") }, modifier = Modifier.fillMaxWidth().testTag("wish-text"))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (kind == "movie" || kind == "show") OutlinedButton(onClick = {
                                run { hits = graph.api.searchWishes(serverId, kind, text.trim()) }
                            }, modifier = Modifier.testTag("wish-search")) { Text("Look it up") }
                            Button(onClick = {
                                val t = text.trim()
                                if (t.isNotEmpty()) run {
                                    graph.api.addWish(serverId, kind, t, null, null, null, null, null, null)
                                    text = ""
                                    hits = null
                                }
                            }, modifier = Modifier.testTag("wish-add")) { Text("Add") }
                        }
                    }
                }
                hits?.let { found ->
                    if (found.isEmpty()) item { Text("Nothing found.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    items(found, key = { "hit-${it.tmdbId}" }) { h ->
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("${h.title}${h.year?.let { " ($it)" } ?: ""}", color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
                            when {
                                h.titleId != null -> TextButton(onClick = { nav.open(Routes.title(serverId, h.titleId)) }) { Text("On the server") }
                                h.wishId != null -> Text("Listed", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                else -> TextButton(onClick = {
                                    run {
                                        graph.api.addWish(serverId, h.kind, h.title, h.year, null, h.tmdbId, h.posterUrl, h.overview, null)
                                        text = ""
                                        hits = null
                                    }
                                }, modifier = Modifier.testTag("pick-${h.tmdbId}")) { Text("Add") }
                            }
                        }
                    }
                }
            }
            if (list.items.isEmpty()) item { Text("Nothing on the wishlist yet.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(list.items, key = { it.id }) { w ->
                Column(Modifier.fillMaxWidth().testTag("wish-${w.id}"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("${w.title}${w.year?.let { " ($it)" } ?: ""}${w.creator?.let { " · $it" } ?: ""}", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
                    Text(statusLine(w), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("wish-status-${w.id}"))
                    w.note?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
                    if (list.canEdit) Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        val onServer = w.onServer
                        if (onServer != null) TextButton(onClick = { nav.open(Routes.title(serverId, onServer.titleId)) }) { Text("Open") }
                        else if (w.status != "got") {
                            TextButton(onClick = { run { graph.api.wantWish(w.id, !w.iWant) } }, modifier = Modifier.testTag("want-${w.id}")) { Text(if (w.iWant) "I don't want it" else "I want it") }
                            if (w.status == "claimed" && w.claimedByMe) {
                                TextButton(onClick = { run { graph.api.wishAction(w.id, "got") } }, modifier = Modifier.testTag("got-${w.id}")) { Text("Got it") }
                                TextButton(onClick = { run { graph.api.wishAction(w.id, "unclaim") } }, modifier = Modifier.testTag("unclaim-${w.id}")) { Text("Not me") }
                            } else if (w.status != "claimed") {
                                TextButton(onClick = { run { graph.api.wishAction(w.id, "claim") } }, modifier = Modifier.testTag("claim-${w.id}")) { Text("I'll get this") }
                            }
                        } else TextButton(onClick = { run { graph.api.wishAction(w.id, "reopen") } }, modifier = Modifier.testTag("reopen-${w.id}")) { Text("Want it again") }
                        if (w.canRemove) TextButton(onClick = { run { graph.api.removeWish(w.id) } }, modifier = Modifier.testTag("remove-${w.id}")) { Text("Remove") }
                    }
                }
            }
        }
    }
}
