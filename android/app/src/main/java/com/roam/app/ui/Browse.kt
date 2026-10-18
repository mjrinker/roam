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
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.roam.app.LocalGraph
import com.roam.app.data.ApiException
import com.roam.app.data.ApiItem
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun SearchScreen(serverId: String, nav: Nav, initialQuery: String = "") {
    val graph = LocalGraph.current
    var query by remember { mutableStateOf(initialQuery) }
    var results by remember { mutableStateOf<List<ApiItem>?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(query) {
        if (query.trim().length < 2) {
            results = null
            return@LaunchedEffect
        }
        delay(500) // a pause in typing
        try {
            results = graph.api.search(serverId, query.trim())
            problem = null
        } catch (e: ApiException) {
            if (e.status == 401) nav.signedOut() else problem = "Couldn't search. ${if (e.status == 0) "Roam can't be reached." else e.message}"
        }
    }
    Column(Modifier.fillMaxSize().padding(if (graph.isTv) 48.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(value = query, onValueChange = { query = it }, singleLine = true, label = { Text("Search") }, modifier = Modifier.fillMaxWidth().testTag("query"))
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        val found = results
        if (found != null && found.isEmpty()) Text("Nothing found.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("nothing"))
        if (found != null) {
            LazyVerticalGrid(columns = GridCells.Adaptive(if (graph.isTv) 170.dp else 120.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                items(found, key = { "${it.type}-${it.id}" }) { item -> PosterCard(item, onClick = { nav.open(routeFor(serverId, item)) }, width = if (graph.isTv) 170.dp else 120.dp) }
            }
        }
    }
}

@Composable
fun AlbumScreen(serverId: String, id: String, nav: Nav) {
    val graph = LocalGraph.current
    val loader = rememberLoader(serverId, id) { graph.api.album(serverId, id) }
    LoadView(loader, nav) { album ->
        LazyColumn(Modifier.fillMaxSize().testTag("album").padding(if (graph.isTv) 48.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            item {
                Text(album.name, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
                album.artist?.let { a ->
                    TextButton(onClick = { nav.open(Routes.artist(serverId, a.id)) }) { Text(a.name) }
                }
            }
            item { RadioButton(artistId = album.artist?.id, songId = null, nav = nav, tag = "radio") }
            items(album.tracks, key = { it.id }) { t ->
                Row(
                    Modifier.fillMaxWidth().focusRing().clickable { nav.open(Routes.audio(t.id, t.name, remember = false)) }.padding(14.dp).testTag("track-${t.id}"),
                    horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("${t.number?.let { "$it. " } ?: ""}${t.name}", color = MaterialTheme.colorScheme.onSurface)
                    t.durationSeconds?.let { Text(clock(it), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
        }
    }
}

@Composable
fun ArtistScreen(serverId: String, id: String, nav: Nav) {
    val graph = LocalGraph.current
    val loader = rememberLoader(serverId, id) { graph.api.artist(serverId, id) }
    LoadView(loader, nav) { artist ->
        Column(Modifier.fillMaxSize().testTag("artist").padding(if (graph.isTv) 48.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(artist.name, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
            RadioButton(artistId = artist.id, songId = null, nav = nav, tag = "radio")
            LazyVerticalGrid(columns = GridCells.Adaptive(if (graph.isTv) 170.dp else 120.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                items(artist.albums, key = { it.id }) { a -> PosterCard(a, onClick = { nav.open(Routes.album(serverId, a.id)) }, width = if (graph.isTv) 170.dp else 120.dp) }
            }
        }
    }
}

@Composable
fun NotificationsScreen(nav: Nav) {
    val graph = LocalGraph.current
    val loader = rememberLoader { graph.api.notifications().also { runCatching { graph.api.markNotificationsRead() } } }
    LoadView(loader, nav) { n ->
        LazyColumn(Modifier.fillMaxSize().testTag("notifications").padding(if (graph.isTv) 48.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { Text("Notifications", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground) }
            if (n.items.isEmpty()) item { Text("Nothing new.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(n.items, key = { it.id }) { item ->
                Text(item.message, color = if (item.read) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface, modifier = Modifier.fillMaxWidth().padding(12.dp))
            }
        }
    }
}

@Composable
fun AccountScreen(nav: Nav, onSwitchProfile: () -> Unit) {
    val graph = LocalGraph.current
    val scope = rememberCoroutineScope()
    val me = rememberLoader { graph.api.me() }
    val devices = rememberLoader { graph.api.devices() }
    var address by remember { mutableStateOf(graph.serverUrl) }
    var note by remember { mutableStateOf<String?>(null) }
    var saverMode by remember { mutableStateOf(graph.settings.dataSaverMode) }
    LoadView(me, nav) { m ->
        LazyColumn(Modifier.fillMaxSize().testTag("account").padding(if (graph.isTv) 48.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text("Account", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
                Text(m.account.email ?: m.account.displayName ?: "", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("Watching as ${m.profile?.name ?: "—"}", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item { Button(onClick = onSwitchProfile, modifier = Modifier.testTag("switch-profile")) { Text("Switch profile") } }
            item {
                Text("Data saver on this device", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground)
                Text("Lower video quality to save mobile data. Automatic turns it on while the connection is metered (mobile data) and off on Wi-Fi.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
            items(com.roam.app.data.DataSaver.MODES, key = { "saver-$it" }) { mode ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    androidx.compose.material3.RadioButton(selected = saverMode == mode, onClick = { saverMode = mode; graph.settings.dataSaverMode = mode }, modifier = Modifier.testTag("saver-$mode"))
                    Text(com.roam.app.data.DataSaver.label(mode), color = MaterialTheme.colorScheme.onSurface)
                }
            }
            item {
                Text("Signed-in devices", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground)
            }
            when (val d = devices.state.value) {
                is Load.Ready -> items(d.value, key = { it.id }) { dev ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text(dev.label + if (dev.current) "  (this device)" else "", color = MaterialTheme.colorScheme.onSurface)
                        if (!dev.current) TextButton(onClick = { scope.launch { runCatching { graph.api.signOutDevice(dev.id) }; devices.reload() } }, modifier = Modifier.testTag("sign-out-${dev.id}")) { Text("Sign out") }
                    }
                }
                else -> item { Text("…", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            item {
                OutlinedTextField(value = address, onValueChange = { address = it }, singleLine = true, label = { Text("Server address") }, modifier = Modifier.fillMaxWidth().testTag("server-address"))
                TextButton(onClick = {
                    val cleaned = address.trim().trimEnd('/')
                    if (cleaned.startsWith("https://") || cleaned.startsWith("http://localhost")) {
                        graph.settings.serverUrl = cleaned
                        graph.settings.signOutLocally() // a different server means signing in to it again
                        nav.signedOut()
                    } else note = "The address has to start with https://"
                }) { Text("Use this address (signs you out)") }
                note?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            item {
                Button(onClick = { scope.launch { runCatching { graph.api.signOut() }; graph.settings.signOutLocally(); nav.signedOut() } }, modifier = Modifier.testTag("sign-out")) { Text("Sign out of this device") }
            }
        }
    }
}
