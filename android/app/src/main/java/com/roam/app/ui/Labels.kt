package com.roam.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.FilledTonalButton
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
import com.roam.app.data.LabelRow
import com.roam.app.data.Title
import kotlinx.coroutines.launch

/** The watch list button and this profile's labels on a title: press a label to put the title under it (or take it out), or make a new one. */
@Composable
fun WatchlistAndLabels(t: Title, nav: Nav) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    var onList by remember(t.id) { mutableStateOf(t.inWatchlist) }
    var rows by remember(t.id) { mutableStateOf<List<LabelRow>?>(null) }
    var open by remember(t.id) { mutableStateOf(false) }
    var name by remember(t.id) { mutableStateOf("") }
    var problem by remember(t.id) { mutableStateOf<String?>(null) }
    fun fail(e: ApiException) {
        if (e.status == 401) nav.signedOut() else problem = if (e.status == 0) "Roam can't be reached." else e.message
    }
    fun loadLabels() {
        scope.launch { try { rows = graph.api.labelsFor(t.id) } catch (e: ApiException) { fail(e) } }
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = {
                val next = !onList
                onList = next
                scope.launch { try { graph.api.setWatchlist(t.id, next); problem = null } catch (e: ApiException) { onList = !next; fail(e) } }
            }, modifier = Modifier.testTag("watchlist")) { Text(if (onList) "On my watch list" else "Add to my watch list") }
            OutlinedButton(onClick = {
                open = !open
                if (open && rows == null) loadLabels()
            }, modifier = Modifier.testTag("labels")) { Text(if (t.labels.isEmpty()) "Labels" else "Labels: " + t.labels.joinToString(", ") { it.name }) }
        }
        if (open) {
            for (l in rows.orEmpty()) {
                val btn: @Composable () -> Unit = { Text(if (l.has) "✓ ${l.name}" else l.name) }
                val go = {
                    scope.launch {
                        try {
                            graph.api.setLabel(l.id, t.id, !l.has)
                            rows = rows?.map { if (it.id == l.id) it.copy(has = !l.has) else it }
                            problem = null
                        } catch (e: ApiException) { fail(e) }
                    }
                    Unit
                }
                if (l.has) FilledTonalButton(onClick = go, modifier = Modifier.testTag("label-${l.id}")) { btn() }
                else OutlinedButton(onClick = go, modifier = Modifier.testTag("label-${l.id}")) { btn() }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true, label = { Text("New label") }, modifier = Modifier.testTag("new-label"))
                TextButton(onClick = {
                    val n = name.trim()
                    if (n.isEmpty()) return@TextButton
                    scope.launch {
                        try {
                            val made = graph.api.createLabel(n, t.id)
                            rows = rows.orEmpty() + made.copy(has = true)
                            name = ""
                            problem = null
                        } catch (e: ApiException) { fail(e) }
                    }
                }, modifier = Modifier.testTag("make-label")) { Text("Make it") }
            }
        }
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("labels-problem")) }
    }
}

@Composable
fun LabelsScreen(serverId: String, nav: Nav) {
    val graph = LocalGraph.current
    val loader = rememberLoader(serverId) { graph.api.labels(serverId) }
    LoadView(loader, nav) { labels ->
        LazyColumn(Modifier.fillMaxSize().testTag("labels-list").padding(if (graph.isTv) 48.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            item { Text("Labels", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground) }
            if (labels.isEmpty()) item { Text("No labels yet. Open a movie or show and press Labels to make one.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(labels, key = { it.id }) { l ->
                Row(
                    Modifier.fillMaxWidth().focusRing().clickable { nav.open(Routes.label(serverId, l.id)) }.padding(14.dp).testTag("label-row-${l.id}"),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(l.name, color = MaterialTheme.colorScheme.onSurface)
                    Text("${l.count}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
fun LabelScreen(serverId: String, id: String, nav: Nav) {
    val graph = LocalGraph.current
    val loader = rememberLoader(serverId, id) { graph.api.label(serverId, id) }
    LoadView(loader, nav) { page ->
        Column(Modifier.fillMaxSize().testTag("label-page").padding(if (graph.isTv) 48.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(page.label.name, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
            if (page.items.isEmpty()) Text("Nothing under this label that you can see.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            LazyVerticalGrid(columns = GridCells.Adaptive(if (graph.isTv) 170.dp else 120.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                items(page.items, key = { "${it.type}-${it.id}" }) { item -> PosterCard(item, onClick = { nav.open(routeFor(serverId, item)) }, width = if (graph.isTv) 170.dp else 120.dp) }
            }
        }
    }
}

/** Starts a radio: songs like an artist (or a song), played one after another. */
@Composable
fun RadioButton(artistId: String?, songId: String?, nav: Nav, tag: String) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    var problem by remember { mutableStateOf<String?>(null) }
    Column {
        OutlinedButton(onClick = {
            scope.launch {
                try {
                    val r = graph.api.radio(artistId, songId)
                    if (r.ids.isEmpty()) problem = "Not enough music like this to make a radio."
                    else nav.open(Routes.audio(r.ids.first(), r.artistName.ifEmpty { "Radio" }, false, r.ids.drop(1)))
                } catch (e: ApiException) {
                    if (e.status == 401) nav.signedOut() else problem = if (e.status == 0) "Roam can't be reached." else e.message
                }
            }
        }, modifier = Modifier.testTag(tag)) { Text("Start radio") }
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("$tag-problem")) }
    }
}
