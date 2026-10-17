package com.roam.app.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A request that didn't succeed. `status` 0 means no connection; `code` is the API's machine-readable reason ("busy", "incorrect_pin"...). */
class ApiException(val status: Int, override val message: String, val code: String = "") : Exception(message)

/** Everything the app asks of Roam. (An interface so screens can be tested with a fake.) */
interface RoamApi {
    suspend fun startDevice(label: String): DeviceStart
    suspend fun pollDevice(deviceCode: String): PollResult
    suspend fun me(): Me
    suspend fun chooseProfile(viewerId: String, pin: String?)
    suspend fun signOut()
    suspend fun servers(): List<ServerSummary>
    suspend fun home(serverId: String): Home
    suspend fun libraries(serverId: String): List<Library>
    suspend fun items(serverId: String, libraryId: String, page: Int? = null, path: String? = null, after: String? = null): ItemsPage
    suspend fun title(serverId: String, id: String, season: Int? = null): Title
    suspend fun search(serverId: String, query: String): List<ApiItem>
    /** A page of a photo library: view is "favorites" or "albums" (with a folder path), or null for the timeline. */
    suspend fun photos(serverId: String, libraryId: String, view: String?, path: String?, after: String?): ItemsPage
    suspend fun photo(serverId: String, id: String, from: String): PhotoView
    suspend fun setFavorite(photoId: String, favorite: Boolean)
    suspend fun playlists(serverId: String): List<PlaylistSummary>
    /** A page of a grid library, sorted ("title", "year" or "added") and narrowed (a genre, only what hasn't been watched). */
    suspend fun filtered(serverId: String, libraryId: String, page: Int, sort: String, genre: String?, unwatched: Boolean): ItemsPage
    suspend fun genres(serverId: String, libraryId: String): List<Genre>
    /** Says this household owns a copy: the answer is "owned", "pending" (the admin settles it), "already_owner" or "already_pending". */
    suspend fun claimOwnership(titleId: String, seasonId: String?): String
    suspend fun shareCopy(titleId: String, seasonId: String?, shared: Boolean)
    suspend fun giveUpOwnership(titleId: String, seasonId: String?)
    /** Marks a title, episode, season or show as watched (done) or not, for this profile. */
    suspend fun markDone(kind: String, id: String, done: Boolean)
    /** Rates a title (half stars 1 to 10) or, with null, clears the rating. */
    suspend fun rate(kind: String, id: String, halfStars: Int?)
    suspend fun registerPush(token: String)
    suspend fun unregisterPush()
    suspend fun playlist(serverId: String, id: String, after: String? = null): PlaylistPage
    suspend fun album(serverId: String, id: String): Album
    suspend fun artist(serverId: String, id: String): Artist
    suspend fun play(kind: String, id: String, unsupportedCodecs: String = ""): PlayManifest
    /** The same, in one of the manifest's versions (a resolution), by its label. */
    suspend fun playVersion(kind: String, id: String, unsupportedCodecs: String, version: String): PlayManifest
    suspend fun audiobook(id: String): AudiobookManifest
    suspend fun audiobookSegmentUrl(id: String, index: Int): String
    suspend fun saveProgress(kind: String, id: String, positionSeconds: Int, durationSeconds: Int, finished: Boolean)
    suspend fun beat(kind: String, id: String, paused: Boolean)
    suspend fun endPlay()
    suspend fun watchWhenFree(titleId: String, seasonId: String?)
    suspend fun notifications(): NotificationsResponse
    suspend fun markNotificationsRead()
    suspend fun devices(): List<DeviceRow>
    suspend fun signOutDevice(id: String)
    /** Puts a movie, show or audiobook on this profile's watch list, or takes it off. */
    suspend fun setWatchlist(titleId: String, on: Boolean)
    /** This profile's labels with how many titles on the server each has. */
    suspend fun labels(serverId: String): List<LabelRow>
    /** One label with the titles under it. */
    suspend fun label(serverId: String, id: String): LabelPage
    /** This profile's labels, each saying whether the title is under it. */
    suspend fun labelsFor(titleId: String): List<LabelRow>
    suspend fun setLabel(labelId: String, titleId: String, on: Boolean)
    /** Makes a label (and puts the title under it, when given). */
    suspend fun createLabel(name: String, titleId: String?): LabelRow
    suspend fun wishlist(serverId: String): WishlistResponse
    suspend fun searchWishes(serverId: String, kind: String, query: String): List<WishHit>
    /** Adds a wish (or, if it is listed already, joins it). A movie already on the server is refused with an ApiException. */
    suspend fun addWish(serverId: String, kind: String, title: String, year: Int?, creator: String?, tmdbId: Int?, posterUrl: String?, overview: String?, note: String?): WishAdded
    suspend fun wantWish(id: String, on: Boolean)
    /** claim, unclaim, got or reopen. */
    suspend fun wishAction(id: String, action: String)
    suspend fun removeWish(id: String)
    /** A radio: songs like an artist, or like a song (which then starts it). */
    suspend fun radio(artistId: String?, songId: String?): RadioResult
}

class HttpRoamApi(
    private val baseUrl: () -> String,
    private val token: () -> String?,
    private val http: OkHttpClient = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build(),
) : RoamApi {
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; explicitNulls = false }
    private val jsonType = "application/json".toMediaType()

    private suspend fun call(method: String, path: String, query: Map<String, String?> = emptyMap(), body: JsonObject? = null): String {
        val url = try {
            val b = (baseUrl().trimEnd('/') + path).toHttpUrl().newBuilder()
            for ((k, v) in query) if (v != null) b.addQueryParameter(k, v)
            b.build()
        } catch (e: IllegalArgumentException) {
            throw ApiException(0, "That server address isn't valid.", "network")
        }
        val req = Request.Builder().url(url).header("Accept", "application/json").header("User-Agent", "Roam-Android/1.0").apply {
            token()?.let { header("Authorization", "Bearer $it") }
            val payload = (body ?: if (method == "GET") null else buildJsonObject { }).let { it?.toString()?.toRequestBody(jsonType) }
            method(method, payload)
        }.build()
        val response = http.newCall(req).await()
        response.use { r ->
            val text = r.body?.string().orEmpty()
            if (!r.isSuccessful) throw error(r.code, text)
            return text
        }
    }

    private fun error(status: Int, text: String): ApiException {
        val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
        val message = obj?.get("error")?.jsonPrimitive?.contentOrNull ?: "Roam answered $status."
        val code = obj?.get("code")?.jsonPrimitive?.contentOrNull ?: ""
        return ApiException(status, message, code)
    }

    private suspend inline fun <reified T> get(path: String, query: Map<String, String?> = emptyMap()): T = json.decodeFromString(call("GET", path, query))

    private suspend inline fun <reified T> post(path: String, body: JsonObject? = null): T = json.decodeFromString(call("POST", path, body = body))

    override suspend fun startDevice(label: String): DeviceStart = post("/api/v1/device/start", buildJsonObject { put("label", JsonPrimitive(label)) })
    override suspend fun pollDevice(deviceCode: String): PollResult = post("/api/v1/device/poll", buildJsonObject { put("deviceCode", JsonPrimitive(deviceCode)) })
    override suspend fun me(): Me = get("/api/v1/me")
    override suspend fun chooseProfile(viewerId: String, pin: String?) {
        call("POST", "/api/v1/me/profile", body = buildJsonObject {
            put("viewerId", JsonPrimitive(viewerId))
            if (pin != null) put("pin", JsonPrimitive(pin))
        })
    }

    override suspend fun signOut() {
        call("DELETE", "/api/v1/session")
    }

    override suspend fun servers(): List<ServerSummary> = get<ServersResponse>("/api/v1/servers").servers
    override suspend fun home(serverId: String): Home = get("/api/v1/servers/$serverId/home")
    override suspend fun libraries(serverId: String): List<Library> = get<LibrariesResponse>("/api/v1/servers/$serverId/libraries").libraries
    override suspend fun items(serverId: String, libraryId: String, page: Int?, path: String?, after: String?): ItemsPage =
        get("/api/v1/servers/$serverId/libraries/$libraryId/items", mapOf("page" to page?.toString(), "path" to path, "after" to after))

    override suspend fun title(serverId: String, id: String, season: Int?): Title = get("/api/v1/servers/$serverId/titles/$id", mapOf("season" to season?.toString()))
    override suspend fun search(serverId: String, query: String): List<ApiItem> = get<SearchResponse>("/api/v1/servers/$serverId/search", mapOf("q" to query)).items
    override suspend fun photos(serverId: String, libraryId: String, view: String?, path: String?, after: String?): ItemsPage =
        get("/api/v1/servers/$serverId/libraries/$libraryId/items", mapOf("view" to view, "path" to path, "after" to after))

    override suspend fun photo(serverId: String, id: String, from: String): PhotoView = get("/api/v1/servers/$serverId/photos/$id", mapOf("from" to from))
    override suspend fun setFavorite(photoId: String, favorite: Boolean) {
        call(if (favorite) "PUT" else "DELETE", "/api/photos/$photoId/favorite")
    }

    override suspend fun filtered(serverId: String, libraryId: String, page: Int, sort: String, genre: String?, unwatched: Boolean): ItemsPage =
        get("/api/v1/servers/$serverId/libraries/$libraryId/items", mapOf("page" to page.toString(), "sort" to sort.takeIf { it != "title" }, "genre" to genre, "unwatched" to if (unwatched) "1" else null))

    override suspend fun genres(serverId: String, libraryId: String): List<Genre> = get<GenresResponse>("/api/v1/servers/$serverId/libraries/$libraryId/genres").genres

    private fun unit(titleId: String, seasonId: String?) = buildJsonObject {
        put("titleId", JsonPrimitive(titleId))
        if (seasonId != null) put("seasonId", JsonPrimitive(seasonId))
    }

    override suspend fun claimOwnership(titleId: String, seasonId: String?): String = json.decodeFromString<ClaimResult>(call("POST", "/api/ownership/claims", body = unit(titleId, seasonId))).status

    override suspend fun shareCopy(titleId: String, seasonId: String?, shared: Boolean) {
        call("PUT", "/api/ownership/mine", body = buildJsonObject {
            put("titleId", JsonPrimitive(titleId))
            if (seasonId != null) put("seasonId", JsonPrimitive(seasonId))
            put("shared", JsonPrimitive(shared))
        })
    }

    override suspend fun giveUpOwnership(titleId: String, seasonId: String?) {
        call("DELETE", "/api/ownership/mine", body = unit(titleId, seasonId))
    }

    override suspend fun markDone(kind: String, id: String, done: Boolean) {
        call("POST", "/api/watch-state/mark", body = buildJsonObject {
            put("kind", JsonPrimitive(kind))
            put("id", JsonPrimitive(id))
            put("done", JsonPrimitive(done))
        })
    }

    override suspend fun rate(kind: String, id: String, halfStars: Int?) {
        call("PUT", "/api/ratings", body = buildJsonObject {
            put("kind", JsonPrimitive(kind))
            put("id", JsonPrimitive(id))
            put("halfStars", if (halfStars == null) kotlinx.serialization.json.JsonNull else JsonPrimitive(halfStars))
        })
    }

    override suspend fun registerPush(token: String) {
        call("PUT", "/api/v1/device/push", body = buildJsonObject { put("token", JsonPrimitive(token)) })
    }

    override suspend fun unregisterPush() {
        call("DELETE", "/api/v1/device/push")
    }

    override suspend fun playlists(serverId: String): List<PlaylistSummary> = get<PlaylistsResponse>("/api/v1/servers/$serverId/playlists").playlists
    override suspend fun playlist(serverId: String, id: String, after: String?): PlaylistPage = get("/api/v1/servers/$serverId/playlists/$id", mapOf("after" to after))
    override suspend fun album(serverId: String, id: String): Album = get("/api/v1/servers/$serverId/albums/$id")
    override suspend fun artist(serverId: String, id: String): Artist = get("/api/v1/servers/$serverId/artists/$id")
    override suspend fun play(kind: String, id: String, unsupportedCodecs: String): PlayManifest =
        get("/api/play/$kind/$id", mapOf("unsupportedCodecs" to unsupportedCodecs.ifEmpty { null }))

    override suspend fun playVersion(kind: String, id: String, unsupportedCodecs: String, version: String): PlayManifest =
        get("/api/play/$kind/$id", mapOf("unsupportedCodecs" to unsupportedCodecs.ifEmpty { null }, "version" to version))

    override suspend fun audiobook(id: String): AudiobookManifest = get("/api/audiobooks/$id/manifest")
    override suspend fun audiobookSegmentUrl(id: String, index: Int): String = get<AudioUrl>("/api/audiobooks/$id/segments/$index").url

    override suspend fun saveProgress(kind: String, id: String, positionSeconds: Int, durationSeconds: Int, finished: Boolean) {
        call("PATCH", "/api/watch-state", body = buildJsonObject {
            put("ownerKind", JsonPrimitive(kind))
            put("ownerId", JsonPrimitive(id))
            put("positionSeconds", JsonPrimitive(positionSeconds))
            put("durationSeconds", JsonPrimitive(durationSeconds))
            put("finished", JsonPrimitive(finished))
        })
    }

    override suspend fun beat(kind: String, id: String, paused: Boolean) {
        call("POST", "/api/playback/beat", body = buildJsonObject {
            put("ownerKind", JsonPrimitive(kind))
            put("ownerId", JsonPrimitive(id))
            put("paused", JsonPrimitive(paused))
        })
    }

    override suspend fun endPlay() {
        call("POST", "/api/playback/end")
    }

    override suspend fun watchWhenFree(titleId: String, seasonId: String?) {
        call("PUT", "/api/playback/watch", body = buildJsonObject {
            put("titleId", JsonPrimitive(titleId))
            if (seasonId != null) put("seasonId", JsonPrimitive(seasonId))
        })
    }

    override suspend fun notifications(): NotificationsResponse = get("/api/notifications")
    override suspend fun markNotificationsRead() {
        call("POST", "/api/notifications/read", body = buildJsonObject { })
    }

    override suspend fun devices(): List<DeviceRow> = get<DevicesResponse>("/api/v1/devices").devices
    override suspend fun signOutDevice(id: String) {
        call("DELETE", "/api/v1/devices/$id")
    }

    override suspend fun setWatchlist(titleId: String, on: Boolean) {
        call("PUT", "/api/watchlist", body = buildJsonObject {
            put("titleId", JsonPrimitive(titleId))
            put("on", JsonPrimitive(on))
        })
    }

    override suspend fun labels(serverId: String): List<LabelRow> = get<LabelsResponse>("/api/v1/servers/$serverId/labels").labels
    override suspend fun label(serverId: String, id: String): LabelPage = get("/api/v1/servers/$serverId/labels/$id")
    override suspend fun labelsFor(titleId: String): List<LabelRow> = get<LabelsResponse>("/api/labels", mapOf("title" to titleId)).labels
    override suspend fun setLabel(labelId: String, titleId: String, on: Boolean) {
        call("PUT", "/api/labels/$labelId/items", body = buildJsonObject {
            put("titleId", JsonPrimitive(titleId))
            put("on", JsonPrimitive(on))
        })
    }

    override suspend fun createLabel(name: String, titleId: String?): LabelRow = json.decodeFromString(call("POST", "/api/labels", body = buildJsonObject {
        put("name", JsonPrimitive(name))
        if (titleId != null) put("titleId", JsonPrimitive(titleId))
    }))

    override suspend fun wishlist(serverId: String): WishlistResponse = get("/api/servers/$serverId/wishlist")
    override suspend fun searchWishes(serverId: String, kind: String, query: String): List<WishHit> =
        get<WishSearchResponse>("/api/servers/$serverId/wishlist/search", mapOf("kind" to kind, "q" to query)).results

    override suspend fun addWish(serverId: String, kind: String, title: String, year: Int?, creator: String?, tmdbId: Int?, posterUrl: String?, overview: String?, note: String?): WishAdded =
        json.decodeFromString(call("POST", "/api/servers/$serverId/wishlist", body = buildJsonObject {
            put("kind", JsonPrimitive(kind))
            put("title", JsonPrimitive(title))
            if (year != null) put("year", JsonPrimitive(year))
            if (!creator.isNullOrBlank()) put("creator", JsonPrimitive(creator))
            if (tmdbId != null) put("tmdbId", JsonPrimitive(tmdbId))
            if (posterUrl != null) put("posterUrl", JsonPrimitive(posterUrl))
            if (!overview.isNullOrBlank()) put("overview", JsonPrimitive(overview))
            if (!note.isNullOrBlank()) put("note", JsonPrimitive(note))
        }))

    override suspend fun wantWish(id: String, on: Boolean) {
        call("PUT", "/api/wishlist/$id/want", body = buildJsonObject { put("on", JsonPrimitive(on)) })
    }

    override suspend fun wishAction(id: String, action: String) {
        call("PATCH", "/api/wishlist/$id", body = buildJsonObject { put("action", JsonPrimitive(action)) })
    }

    override suspend fun removeWish(id: String) {
        call("DELETE", "/api/wishlist/$id")
    }

    override suspend fun radio(artistId: String?, songId: String?): RadioResult =
        get("/api/music/radio", mapOf("artist" to artistId, "song" to songId))
}

/** An OkHttp call as a suspending function (a failed connection becomes an ApiException with status 0). */
private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(ApiException(0, e.message ?: "Roam can't be reached.", "network"))
        }

        override fun onResponse(call: Call, response: Response) {
            cont.resume(response)
        }
    })
    cont.invokeOnCancellation { cancel() }
}

/** For tests and previews: every call fails, so a test overrides only what it uses. */
object Unsupported : RoamApi {
    private fun nope(): Nothing = throw UnsupportedOperationException("not faked")
    override suspend fun startDevice(label: String) = nope()
    override suspend fun pollDevice(deviceCode: String) = nope()
    override suspend fun me() = nope()
    override suspend fun chooseProfile(viewerId: String, pin: String?) = nope()
    override suspend fun signOut() = nope()
    override suspend fun servers() = nope()
    override suspend fun home(serverId: String) = nope()
    override suspend fun libraries(serverId: String) = nope()
    override suspend fun items(serverId: String, libraryId: String, page: Int?, path: String?, after: String?) = nope()
    override suspend fun title(serverId: String, id: String, season: Int?) = nope()
    override suspend fun search(serverId: String, query: String) = nope()
    override suspend fun photos(serverId: String, libraryId: String, view: String?, path: String?, after: String?) = nope()
    override suspend fun photo(serverId: String, id: String, from: String) = nope()
    override suspend fun setFavorite(photoId: String, favorite: Boolean) = nope()
    override suspend fun filtered(serverId: String, libraryId: String, page: Int, sort: String, genre: String?, unwatched: Boolean) = nope()
    override suspend fun genres(serverId: String, libraryId: String) = nope()
    override suspend fun claimOwnership(titleId: String, seasonId: String?) = nope()
    override suspend fun shareCopy(titleId: String, seasonId: String?, shared: Boolean) = nope()
    override suspend fun giveUpOwnership(titleId: String, seasonId: String?) = nope()
    override suspend fun markDone(kind: String, id: String, done: Boolean) = nope()
    override suspend fun rate(kind: String, id: String, halfStars: Int?) = nope()
    override suspend fun registerPush(token: String) = nope()
    override suspend fun unregisterPush() = nope()
    override suspend fun playlists(serverId: String) = nope()
    override suspend fun playlist(serverId: String, id: String, after: String?) = nope()
    override suspend fun album(serverId: String, id: String) = nope()
    override suspend fun artist(serverId: String, id: String) = nope()
    override suspend fun play(kind: String, id: String, unsupportedCodecs: String) = nope()
    override suspend fun playVersion(kind: String, id: String, unsupportedCodecs: String, version: String) = nope()
    override suspend fun audiobook(id: String) = nope()
    override suspend fun audiobookSegmentUrl(id: String, index: Int) = nope()
    override suspend fun saveProgress(kind: String, id: String, positionSeconds: Int, durationSeconds: Int, finished: Boolean) = nope()
    override suspend fun beat(kind: String, id: String, paused: Boolean) = nope()
    override suspend fun endPlay() = nope()
    override suspend fun watchWhenFree(titleId: String, seasonId: String?) = nope()
    override suspend fun notifications() = nope()
    override suspend fun markNotificationsRead() = nope()
    override suspend fun devices() = nope()
    override suspend fun signOutDevice(id: String) = nope()
    override suspend fun setWatchlist(titleId: String, on: Boolean) = nope()
    override suspend fun labels(serverId: String) = nope()
    override suspend fun label(serverId: String, id: String) = nope()
    override suspend fun labelsFor(titleId: String) = nope()
    override suspend fun setLabel(labelId: String, titleId: String, on: Boolean) = nope()
    override suspend fun createLabel(name: String, titleId: String?) = nope()
    override suspend fun wishlist(serverId: String) = nope()
    override suspend fun searchWishes(serverId: String, kind: String, query: String) = nope()
    override suspend fun addWish(serverId: String, kind: String, title: String, year: Int?, creator: String?, tmdbId: Int?, posterUrl: String?, overview: String?, note: String?) = nope()
    override suspend fun wantWish(id: String, on: Boolean) = nope()
    override suspend fun wishAction(id: String, action: String) = nope()
    override suspend fun removeWish(id: String) = nope()
    override suspend fun radio(artistId: String?, songId: String?) = nope()
}
