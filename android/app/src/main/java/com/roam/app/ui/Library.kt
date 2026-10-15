package com.roam.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.roam.app.LocalGraph
import com.roam.app.data.ApiException
import com.roam.app.data.ApiItem

/** A library: a grid of titles (more arrive as you reach the end), the folders and videos of a video library, or a music library's artists. */
@Composable
fun LibraryScreen(serverId: String, libraryId: String, style: String, name: String, nav: Nav) {
    val graph = LocalGraph.current
    var path by remember { mutableStateOf("") }
    val folders = remember { mutableStateListOf<String>() }
    val items = remember { mutableStateListOf<ApiItem>() }
    var page by remember { mutableStateOf(0) }
    var after by remember { mutableStateOf<String?>(null) }
    var more by remember { mutableStateOf(true) }
    var loading by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(path) {
        // A new folder starts the listing over.
        items.clear(); folders.clear(); page = 0; after = null; more = true; problem = null
    }
    // Loads the next page; called when the end of the list comes into view, and once to begin.
    suspend fun loadMore() {
        if (loading || !more || style == "timeline") return
        loading = true
        try {
            val next = graph.api.items(serverId, libraryId, page = if (style == "grid") page + 1 else null, path = if (style == "folders") path else null, after = after)
            if (style == "grid") page += 1
            if (next.path != null && folders.isEmpty()) folders.addAll(next.folders)
            items.addAll(next.items)
            after = next.next
            more = if (style == "grid") next.hasMore else next.next != null
        } catch (e: ApiException) {
            if (e.status == 401) nav.signedOut() else problem = if (e.status == 0) "Roam can't be reached." else e.message
            more = false
        } finally {
            loading = false
        }
    }
    LaunchedEffect(path, more) { if (items.isEmpty() && more) loadMore() }

    val pad = if (graph.isTv) 48.dp else 16.dp
    Column(Modifier.fillMaxSize().padding(pad).testTag("library")) {
        Text(if (path.isEmpty()) name else path.substringAfterLast('/'), style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
        if (style == "timeline") {
            Text("Photos aren't in this app yet. Use the web version for now.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 16.dp))
            return@Column
        }
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp).testTag("problem")) }
        LazyVerticalGrid(columns = GridCells.Adaptive(if (graph.isTv) 170.dp else 120.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(16.dp), modifier = Modifier.padding(top = 12.dp)) {
            if (style == "folders") {
                items(folders, span = { GridItemSpan(maxLineSpan) }) { folder ->
                    Text(
                        "📁  $folder", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.fillMaxWidth().focusRing().clickable { path = if (path.isEmpty()) folder else "$path/$folder" }.padding(16.dp).testTag("folder-$folder"),
                    )
                }
            }
            items(items, key = { "${it.type}-${it.id}" }) { item -> PosterCard(item, onClick = { nav.open(routeFor(serverId, item)) }, width = if (graph.isTv) 170.dp else 120.dp) }
            if (more) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    LaunchedEffect(items.size) { loadMore() }
                    CircularProgressIndicator(Modifier.fillMaxWidth().padding(16.dp))
                }
            }
        }
    }
}
