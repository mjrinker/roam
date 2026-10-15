package com.roam.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.roam.app.LocalGraph
import com.roam.app.data.ApiItem
import com.roam.app.data.Home

@Composable
fun HomeScreen(serverId: String, nav: Nav) {
    val graph = LocalGraph.current
    if (graph.push.available) {
        AllowNotifications()
        androidx.compose.runtime.LaunchedEffect(Unit) { graph.push.register(graph.api) }
    }
    val loader = rememberLoader(serverId) { graph.api.home(serverId) }
    LoadView(loader, nav) { home ->
        androidx.compose.runtime.LaunchedEffect(home) { graph.continueRow.publish(home.continueWatching, graph.serverUrl) }
        HomeContent(serverId, home, nav)
    }
}

@Composable
fun HomeContent(serverId: String, home: Home, nav: Nav) {
    val graph = LocalGraph.current
    val pad = if (graph.isTv) 48.dp else 16.dp
    LazyColumn(Modifier.fillMaxSize().testTag("home"), contentPadding = androidx.compose.foundation.layout.PaddingValues(pad), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(home.server.name, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground)
                Row {
                    TextButton(onClick = { nav.open(Routes.search(serverId)) }, modifier = Modifier.testTag("go-search")) { Text("Search") }
                    if (home.hasPlaylists) TextButton(onClick = { nav.open(Routes.playlists(serverId)) }, modifier = Modifier.testTag("go-playlists")) { Text("Playlists") }
                    TextButton(onClick = { nav.open(Routes.NOTIFICATIONS) }, modifier = Modifier.testTag("go-notifications")) { Text(if (home.unreadNotifications > 0) "Notifications (${home.unreadNotifications})" else "Notifications") }
                    TextButton(onClick = { nav.open(Routes.ACCOUNT) }, modifier = Modifier.testTag("go-account")) { Text("Account") }
                }
            }
        }
        row("Continue watching", home.continueWatching, serverId, nav)
        row("Up next", home.upNext, serverId, nav)
        row("Continue listening", home.continueListening, serverId, nav)
        row("Recently added", home.recentlyAdded, serverId, nav)
        item {
            Text("Libraries", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground)
        }
        item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                items(home.libraries.filter { it.style != null }, key = { it.id }) { lib ->
                    Text(
                        lib.name, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.clip(RoundedCornerShape(10.dp)).focusRing().clickable { nav.open(Routes.library(serverId, lib.id, lib.style!!, lib.name)) }
                            .padding(horizontal = 20.dp, vertical = 14.dp).testTag("library-${lib.id}"),
                    )
                }
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.row(title: String, items: List<ApiItem>, serverId: String, nav: Nav) {
    if (items.isEmpty()) return
    item(key = title) {
        androidx.compose.foundation.layout.Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                items(items, key = { "${it.type}-${it.id}" }) { item -> PosterCard(item, onClick = { nav.open(routeFor(serverId, item)) }) }
            }
        }
    }
}
