package com.roam.app

import android.app.SearchManager
import android.content.Intent
import android.net.Uri
import com.roam.app.data.ApiItem
import com.roam.app.ui.Routes

/** Where an outside request leads: the launcher's "continue watching" (`roam://item/<type>/<id>`) and a spoken or typed search from the system. */
object DeepLink {
    fun uriFor(item: ApiItem): String = "roam://item/${item.type}/${item.id}"

    private val ID = Regex("^[0-9a-fA-F-]{8,40}$")

    /** The screen to open for an address, or null when it isn't one of ours (or there is no server chosen yet). */
    fun routeFor(uri: Uri, serverId: String?): String? {
        if (uri.scheme != "roam" || serverId == null) return null
        if (uri.host == "search") return uri.getQueryParameter("q")?.trim()?.takeIf { it.isNotEmpty() }?.let { Routes.search(serverId, it) }
        if (uri.host != "item") return null
        val parts = uri.pathSegments
        if (parts.size != 2 || !ID.matches(parts[1])) return null
        val id = parts[1]
        return when (parts[0]) {
            "movie", "show", "audiobook" -> Routes.title(serverId, id)
            "episode" -> Routes.player("episode", id, "")
            "album" -> Routes.album(serverId, id)
            "artist" -> Routes.artist(serverId, id)
            else -> null
        }
    }

    /** The screen an incoming intent asks for, or null. */
    fun routeFor(intent: Intent?, serverId: String?): String? {
        if (intent == null || serverId == null) return null
        return when (intent.action) {
            Intent.ACTION_VIEW -> intent.data?.let { routeFor(it, serverId) }
            Intent.ACTION_SEARCH, "com.google.android.gms.actions.SEARCH_ACTION", "android.media.action.MEDIA_PLAY_FROM_SEARCH" ->
                (intent.getStringExtra(SearchManager.QUERY))?.trim()?.takeIf { it.isNotEmpty() }?.take(100)?.let { Routes.search(serverId, it) }
            else -> null
        }
    }
}
