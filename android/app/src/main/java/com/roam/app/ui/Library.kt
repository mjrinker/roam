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
    // A photo library is seen as the timeline, the favourites, or the albums (folders).
    var mode by remember { mutableStateOf("timeline") }
    val photos = style == "timeline"
    // A grid library can be sorted and narrowed (the same choices the TV interface has).
    var sort by remember { mutableStateOf("title") }
    var genre by remember { mutableStateOf<String?>(null) }
    var unwatched by remember { mutableStateOf(false) }
    var choosingGenre by remember { mutableStateOf(false) }
    val narrowed = sort != "title" || genre != null || unwatched
    val folders = remember { mutableStateListOf<String>() }
    val items = remember { mutableStateListOf<ApiItem>() }
    var page by remember { mutableStateOf(0) }
    var after by remember { mutableStateOf<String?>(null) }
    var more by remember { mutableStateOf(true) }
    var loading by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(path, mode, sort, genre, unwatched) {
        // A new folder starts the listing over.
        items.clear(); folders.clear(); page = 0; after = null; more = true; problem = null
    }
    // Loads the next page; called when the end of the list comes into view, and once to begin.
    suspend fun loadMore() {
        if (loading || !more) return
        loading = true
        try {
            val next = if (photos) graph.api.photos(serverId, libraryId, view = if (mode == "timeline") null else mode, path = if (mode == "albums") path else null, after = after)
            else if (style == "grid" && narrowed) graph.api.filtered(serverId, libraryId, page + 1, sort, genre, unwatched)
            else graph.api.items(serverId, libraryId, page = if (style == "grid") page + 1 else null, path = if (style == "folders") path else null, after = after)
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
    LaunchedEffect(path, mode, sort, genre, unwatched, more) { if (items.isEmpty() && more) loadMore() }

    val pad = if (graph.isTv) 48.dp else 16.dp
    if (choosingGenre) GenreDialog(serverId, libraryId, genre, onPick = { genre = it; choosingGenre = false }, onClose = { choosingGenre = false })
    Column(Modifier.fillMaxSize().padding(pad).testTag("library")) {
        Text(if (path.isEmpty()) name else path.substringAfterLast('/'), style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
        if (photos) {
            androidx.compose.foundation.layout.Row {
                for ((key, label) in listOf("timeline" to "Timeline", "favorites" to "Favourites", "albums" to "Albums")) {
                    androidx.compose.material3.TextButton(onClick = { mode = key; path = "" }, modifier = Modifier.testTag("mode-$key")) {
                        Text(label, color = if (mode == key) Accent else MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
        }
        if (style == "grid") {
            androidx.compose.foundation.layout.Row {
                androidx.compose.material3.TextButton(onClick = { sort = when (sort) { "title" -> "year"; "year" -> "added"; else -> "title" } }, modifier = Modifier.testTag("sort")) {
                    Text("Sort: " + when (sort) { "year" -> "Newest year"; "added" -> "Recently added"; else -> "Title" })
                }
                androidx.compose.material3.TextButton(onClick = { choosingGenre = true }, modifier = Modifier.testTag("genre")) { Text("Genre: ${genre ?: "Any"}") }
                androidx.compose.material3.TextButton(onClick = { unwatched = !unwatched }, modifier = Modifier.testTag("unwatched")) { Text("Unwatched only: ${if (unwatched) "On" else "Off"}") }
                if (narrowed) androidx.compose.material3.TextButton(onClick = { sort = "title"; genre = null; unwatched = false }, modifier = Modifier.testTag("clear")) { Text("Clear") }
            }
        }
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp).testTag("problem")) }
        LazyVerticalGrid(columns = GridCells.Adaptive(if (graph.isTv) 170.dp else 120.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(16.dp), modifier = Modifier.padding(top = 12.dp)) {
            if (style == "folders" || (photos && mode == "albums")) {
                items(folders, span = { GridItemSpan(maxLineSpan) }) { folder ->
                    Text(
                        "📁  $folder", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.fillMaxWidth().focusRing().clickable { path = if (path.isEmpty()) folder else "$path/$folder" }.padding(16.dp).testTag("folder-$folder"),
                    )
                }
            }
            items(items, key = { "${it.type}-${it.id}" }) { item ->
                val open = if (item.type == "photo") Routes.photo(serverId, item.id, if (mode == "favorites") "favorites" else if (mode == "albums") "album" else "timeline") else routeFor(serverId, item)
                PosterCard(item, onClick = { nav.open(open) }, width = if (graph.isTv) 170.dp else 120.dp)
            }
            if (more) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    LaunchedEffect(items.size) { loadMore() }
                    CircularProgressIndicator(Modifier.fillMaxWidth().padding(16.dp))
                }
            }
        }
    }
}

/** The library's genres to choose from. */
@Composable
private fun GenreDialog(serverId: String, libraryId: String, current: String?, onPick: (String?) -> Unit, onClose: () -> Unit) {
    val graph = LocalGraph.current
    val genres = rememberLoader(serverId, libraryId) { graph.api.genres(serverId, libraryId) }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Genre") },
        text = {
            when (val g = genres.state.value) {
                is Load.Ready -> androidx.compose.foundation.lazy.LazyColumn(Modifier.testTag("genre-list")) {
                    item { androidx.compose.material3.TextButton(onClick = { onPick(null) }, modifier = Modifier.testTag("genre-any")) { Text(if (current == null) "✓ Any genre" else "Any genre") } }
                    items(g.value.size) { i ->
                        val it = g.value[i]
                        androidx.compose.material3.TextButton(onClick = { onPick(it.name) }, modifier = Modifier.testTag("genre-${it.name}")) { Text("${if (current == it.name) "✓ " else ""}${it.name} (${it.count})") }
                    }
                }
                is Load.Failed -> Text("Couldn't load the genres.")
                else -> CircularProgressIndicator()
            }
        },
        confirmButton = { androidx.compose.material3.TextButton(onClick = onClose) { Text("Close") } },
    )
}
