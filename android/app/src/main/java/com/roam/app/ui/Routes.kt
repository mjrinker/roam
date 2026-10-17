package com.roam.app.ui

import android.net.Uri

/** Every screen's address. Words in an address are encoded, so a title with a slash or a question mark in it still opens. */
object Routes {
    const val SIGN_IN = "signin"
    const val GATE = "gate?force={force}"
    fun gate(force: Boolean = false) = "gate?force=$force"
    const val HOME = "home/{sid}"
    fun home(sid: String) = "home/$sid"
    const val LIBRARY = "library/{sid}/{lid}/{style}/{name}"
    fun library(sid: String, lid: String, style: String, name: String) = "library/$sid/$lid/$style/${Uri.encode(name)}"
    const val TITLE = "title/{sid}/{id}"
    fun title(sid: String, id: String) = "title/$sid/$id"
    const val ALBUM = "album/{sid}/{id}"
    fun album(sid: String, id: String) = "album/$sid/$id"
    const val ARTIST = "artist/{sid}/{id}"
    fun artist(sid: String, id: String) = "artist/$sid/$id"
    const val SEARCH = "search/{sid}?q={q}"
    fun search(sid: String, query: String = "") = "search/$sid?q=${Uri.encode(query)}"
    const val PLAYER = "player/{kind}/{id}?name={name}&startOver={startOver}&startAt={startAt}&queue={queue}"
    fun player(kind: String, id: String, name: String, startOver: Boolean = false, startAt: Double? = null, queue: List<String> = emptyList()) =
        "player/$kind/$id?name=${Uri.encode(name)}&startOver=$startOver&startAt=${startAt ?: -1.0}&queue=${Uri.encode(queue.joinToString(","))}"
    const val AUDIO = "audio/{id}?name={name}&remember={remember}&queue={queue}"
    fun audio(id: String, name: String, remember: Boolean, queue: List<String> = emptyList()) = "audio/$id?name=${Uri.encode(name)}&remember=$remember&queue=${Uri.encode(queue.joinToString(","))}"
    const val PHOTO = "photo/{sid}/{id}?from={from}"
    fun photo(sid: String, id: String, from: String = "timeline") = "photo/$sid/$id?from=$from"
    const val PLAYLISTS = "playlists/{sid}"
    fun playlists(sid: String) = "playlists/$sid"
    const val PLAYLIST = "playlist/{sid}/{id}"
    fun playlist(sid: String, id: String) = "playlist/$sid/$id"
    const val LABELS = "labels/{sid}"
    fun labels(sid: String) = "labels/$sid"
    const val LABEL = "label/{sid}/{id}"
    fun label(sid: String, id: String) = "label/$sid/$id"
    const val WISHLIST = "wishlist/{sid}"
    fun wishlist(sid: String) = "wishlist/$sid"
    const val NOTIFICATIONS = "notifications"
    const val ACCOUNT = "account"
}
