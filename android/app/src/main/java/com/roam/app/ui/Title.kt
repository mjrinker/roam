package com.roam.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import kotlinx.coroutines.launch
import com.roam.app.LocalGraph
import com.roam.app.data.Title

fun clock(totalSeconds: Double): String {
    val s = totalSeconds.toLong().coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}

/** A movie, a show (one season's episodes at a time) or an audiobook. */
@Composable
fun TitleScreen(serverId: String, id: String, nav: Nav) {
    val graph = LocalGraph.current
    var season by remember { mutableStateOf<Int?>(null) }
    val loader = rememberLoader(serverId, id, season) { graph.api.title(serverId, id, season) }
    LoadView(loader, nav) { title -> TitleContent(serverId, title, nav, onSeason = { season = it }, onChanged = loader.reload) }
}

@Composable
fun TitleContent(serverId: String, t: Title, nav: Nav, onSeason: (Int) -> Unit, onChanged: () -> Unit = {}) {
    val graph = LocalGraph.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var ownerNote by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf<String?>(null) }
    // Runs one ownership change, says what happened, and reloads the page so it shows the new state.
    fun change(done: String?, block: suspend () -> String?) {
        scope.launch {
            try {
                ownerNote = block() ?: done
                onChanged()
            } catch (e: com.roam.app.data.ApiException) {
                if (e.status == 401) nav.signedOut() else ownerNote = if (e.status == 0) "Roam can't be reached." else e.message
            }
        }
    }
    // Marking something watched (or not) reloads the page so the marks show.
    val mark: (String, String, Boolean) -> Unit = { kind, id, done -> change(null) { graph.api.markDone(kind, id, done); null } }
    val pad = if (graph.isTv) 48.dp else 16.dp
    LazyColumn(Modifier.fillMaxSize().testTag("title"), contentPadding = androidx.compose.foundation.layout.PaddingValues(pad), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                AsyncImage(
                    model = t.posterUrl, contentDescription = null, contentScale = ContentScale.Crop,
                    modifier = Modifier.size(width = if (graph.isTv) 200.dp else 110.dp, height = if (graph.isTv) 300.dp else 165.dp).clip(androidx.compose.foundation.shape.RoundedCornerShape(10.dp)),
                )
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(t.name, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground, modifier = Modifier.testTag("title-name"))
                    val facts = listOfNotNull(t.year?.toString(), t.runtimeSeconds?.let { clock(it.toDouble()) }, t.certification, t.authors.takeIf { it.isNotEmpty() }?.joinToString(", "))
                    if (facts.isNotEmpty()) Text(facts.joinToString("  ·  "), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    t.narrators.takeIf { it.isNotEmpty() }?.let { Text("Read by ${it.joinToString(", ")}", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    t.overview?.let { Text(it, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium, maxLines = 6) }
                }
            }
        }
        when (t.type) {
            "movie" -> movieActions(t, nav, mark)
            "show" -> showBody(serverId, t, nav, onSeason, mark)
            "audiobook" -> item {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(onClick = { nav.open(Routes.audio(t.id, t.name, remember = true)) }, modifier = Modifier.testTag("play")) {
                        Text(t.resume?.let { "Resume from ${clock(it.positionSeconds)}" } ?: "Listen")
                    }
                }
            }
        }
        t.guide?.takeIf { it.lines.isNotEmpty() || it.reports.isNotEmpty() }?.let { g ->
            item { Text("Parental guide", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground) }
            for (l in g.lines) item {
                Text(
                    "${l.category.replaceFirstChar { it.uppercase() }}${l.severity?.let { " · $it" } ?: ""} — ${l.scenes} scene${if (l.scenes == 1) "" else "s"}, ${l.seconds} sec${if (l.skippedForYou) " · skipped for you" else ""}",
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("guide-line"),
                )
            }
            for (r in g.reports) item { Text("${r.topic}: ${r.yes} yes, ${r.no} no", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            // Does the Dog Die's terms: its credit, and that these reports aren't verified, wherever its data shows.
            if (g.fromCommunity) item { Text("Powered by DoesTheDogDie.com. These reports come from the community, aren't verified, and may be incomplete: no warning doesn't mean the content isn't there.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("ddd-credit")) }
        }
        if (t.chapters.isNotEmpty()) {
            item { Text("Chapters", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground) }
            for (c in t.chapters) item {
                Text(
                    "${clock(c.startSeconds)}   ${c.title}", color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.fillMaxWidth().focusRing().clickable { nav.open(Routes.player("title", t.id, t.name, startAt = c.startSeconds)) }.padding(12.dp).testTag("chapter-${c.startSeconds.toInt()}"),
                )
            }
        }
        for (group in t.extras) {
            item { Text(group.category.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground) }
            for (e in group.items) item {
                Text(
                    "${e.name}  ·  ${clock(e.durationSeconds)}", color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.fillMaxWidth().focusRing().clickable { nav.open(Routes.player("extra", e.id, e.name)) }.padding(12.dp).testTag("extra-${e.id}"),
                )
            }
        }
        if (t.cast.isNotEmpty()) {
            item { Text("Cast", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground) }
            item { Text(t.cast.joinToString("   ") { c -> if (c.character != null) "${c.name} (${c.character})" else c.name }, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        t.ownership?.let { o ->
            item { Text("Who owns it", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onBackground) }
            for (u in o.units) item {
                val what = u.label?.let { "$it: " } ?: ""
                Text(
                    what + when {
                        !u.playable -> "every owner has withdrawn this"
                        u.iOwn -> if (u.myShared) "you own it and share it" else "you own it, and have withdrawn your copy"
                        else -> "you haven't said you own it"
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("ownership-line"),
                )
                if (o.canChange) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (!u.iOwn) {
                        androidx.compose.material3.OutlinedButton(onClick = {
                            change(null) {
                                when (graph.api.claimOwnership(t.id, u.seasonId)) {
                                    "owned" -> "Marked as yours."
                                    "pending" -> "Sent to the admin to settle."
                                    "already_pending" -> "Already waiting for the admin."
                                    else -> null
                                }
                            }
                        }, modifier = Modifier.testTag("claim-${u.seasonId ?: "title"}")) { Text("I own this") }
                    } else {
                        androidx.compose.material3.OutlinedButton(onClick = { change(if (u.myShared) "Your copy is withdrawn." else "Your copy is shared again.") { graph.api.shareCopy(t.id, u.seasonId, !u.myShared); null } }, modifier = Modifier.testTag("share-${u.seasonId ?: "title"}")) {
                            Text(if (u.myShared) "Withdraw my copy" else "Share my copy")
                        }
                        androidx.compose.material3.TextButton(onClick = { change("You no longer own this.") { graph.api.giveUpOwnership(t.id, u.seasonId); null } }, modifier = Modifier.testTag("giveup-${u.seasonId ?: "title"}")) { Text("I don't own this") }
                    }
                }
            }
            ownerNote?.let { item { Text(it, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.testTag("ownership-note")) } }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.movieActions(t: Title, nav: Nav, mark: (String, String, Boolean) -> Unit) {
    item {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(onClick = { nav.open(Routes.player("title", t.id, t.name)) }, modifier = Modifier.testTag("play")) {
                Text(t.resume?.let { "Resume from ${clock(it.positionSeconds)}" } ?: "Play")
            }
            if (t.resume != null) OutlinedButton(onClick = { nav.open(Routes.player("title", t.id, t.name, startOver = true)) }, modifier = Modifier.testTag("start-over")) { Text("Start over") }
            OutlinedButton(onClick = { mark("title", t.id, !t.finished) }, modifier = Modifier.testTag("mark")) { Text(if (t.finished) "Mark not watched" else "Mark watched") }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.showBody(serverId: String, t: Title, nav: Nav, onSeason: (Int) -> Unit, mark: (String, String, Boolean) -> Unit) {
    val ids = t.episodes.map { it.id }
    t.continueEpisodeId?.let { next ->
        item {
            val resuming = t.episodes.any { it.id == next && it.inProgress }
            Button(onClick = { nav.open(Routes.player("episode", next, t.name, queue = ids.dropWhile { it != next }.drop(1))) }, modifier = Modifier.testTag("play")) {
                Text(if (resuming) "Resume next episode" else "Play next episode")
            }
        }
    }
    item {
        OutlinedButton(onClick = { mark("show", t.id, !t.watched) }, modifier = Modifier.testTag("mark")) { Text(if (t.watched) "Mark show not watched" else "Mark show watched") }
    }
    if (t.seasons.size > 1) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (n in t.seasons) {
                    val selected = n == t.season
                    (if (selected) androidx.compose.material3.FilledTonalButton(onClick = { onSeason(n) }, modifier = Modifier.testTag("season-$n")) { Text("Season $n") }
                    else OutlinedButton(onClick = { onSeason(n) }, modifier = Modifier.testTag("season-$n")) { Text("Season $n") })
                }
            }
        }
    }
    for ((i, e) in t.episodes.withIndex()) {
        item(key = e.id) {
            Row(
                Modifier.fillMaxWidth().focusRing().clickable { nav.open(Routes.player("episode", e.id, t.name, queue = ids.drop(i + 1))) }.padding(14.dp).testTag("episode-${e.id}"),
                horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("${e.number}. ${e.name ?: "Episode ${e.number}"}", color = MaterialTheme.colorScheme.onSurface)
                if (e.watched) Text("Watched", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                else if (e.inProgress) Text("In progress", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall)
                androidx.compose.material3.TextButton(onClick = { mark("episode", e.id, !e.watched) }, modifier = Modifier.testTag("mark-${e.id}")) { Text(if (e.watched) "Mark unwatched" else "Mark watched") }
            }
        }
    }
}
