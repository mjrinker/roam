package com.roam.app.data

import kotlinx.serialization.Serializable

/** The JSON the API answers with (docs/api.md). Unknown fields are ignored, so the server can add fields without breaking the app. */

@Serializable
data class DeviceStart(
    val userCode: String,
    val deviceCode: String,
    val verificationUrl: String,
    val verificationUrlComplete: String = "",
    val expiresIn: Int = 600,
    val interval: Int = 3,
)

@Serializable
data class PollResult(val status: String, val accessToken: String? = null, val profileSelected: Boolean = false)

@Serializable
data class Account(val id: String, val email: String? = null, val displayName: String? = null, val isGuest: Boolean = false)

@Serializable
data class ProfileSummary(
    val id: String,
    val name: String,
    val avatarKey: String? = null,
    val role: String = "",
    val hasPin: Boolean = false,
    val selected: Boolean = false,
)

@Serializable
data class Me(val account: Account, val profile: ProfileSummary? = null, val profiles: List<ProfileSummary> = emptyList())

@Serializable
data class ServerSummary(val id: String, val name: String, val role: String = "")

@Serializable
data class ServersResponse(val servers: List<ServerSummary> = emptyList())

/** A thing in a list: enough to draw a card and to open or play it. `type` is movie, show, episode, audiobook, audio, album, artist, photo or clip. */
@Serializable
data class ApiItem(
    val type: String,
    val id: String,
    val name: String,
    val subtitle: String? = null,
    val posterUrl: String? = null,
    val square: Boolean = false,
    val progress: Double? = null,
)

@Serializable
data class Library(val id: String, val name: String, val kind: String, val style: String? = null)

@Serializable
data class LibrariesResponse(val libraries: List<Library> = emptyList())

@Serializable
data class ServerRef(val id: String, val name: String)

@Serializable
data class Home(
    val server: ServerRef,
    val libraries: List<Library> = emptyList(),
    val continueWatching: List<ApiItem> = emptyList(),
    val upNext: List<ApiItem> = emptyList(),
    val continueListening: List<ApiItem> = emptyList(),
    val recentlyAdded: List<ApiItem> = emptyList(),
    val hasPlaylists: Boolean = false,
    val unreadNotifications: Int = 0,
)

@Serializable
data class Ok(val ok: Boolean = true)

@Serializable
data class Genre(val name: String, val count: Int = 0)

@Serializable
data class GenresResponse(val genres: List<Genre> = emptyList())

@Serializable
data class ClaimResult(val status: String = "")

@Serializable
data class MoreInCollection(val id: String, val name: String, val items: List<ApiItem> = emptyList())

@Serializable
data class PhotoRef(val type: String, val id: String)

@Serializable
data class PhotoView(
    val id: String,
    val type: String = "photo",
    val name: String = "",
    val takenAt: String? = null,
    val favorite: Boolean = false,
    val folderPath: String = "",
    val imagePath: String? = null,
    val prev: PhotoRef? = null,
    val next: PhotoRef? = null,
)

@Serializable
data class PlaylistSummary(val id: String, val name: String, val itemCount: Int = 0, val ownerName: String? = null, val canAdd: Boolean = false)

@Serializable
data class PlaylistsResponse(val playlists: List<PlaylistSummary> = emptyList())

/** A playlist entry: an ApiItem-like thing, with the entry's own id and whether it can be played yet. */
@Serializable
data class PlaylistEntry(
    val entryId: String,
    val type: String,
    val id: String,
    val name: String,
    val subtitle: String? = null,
    val posterUrl: String? = null,
    val square: Boolean = false,
    val playable: Boolean = true,
) {
    fun asItem() = ApiItem(type, id, name, subtitle, posterUrl, square)
}

@Serializable
data class PlaylistHeader(val id: String, val name: String, val description: String? = null, val itemCount: Int = 0, val ownerName: String? = null)

@Serializable
data class PlaylistPage(val playlist: PlaylistHeader, val items: List<PlaylistEntry> = emptyList(), val next: String? = null)

/** One page of a library: a grid (page, hasMore), or folders and files (path, folders, next). */
@Serializable
data class ItemsPage(
    val page: Int? = null,
    val hasMore: Boolean = false,
    val path: String? = null,
    val folders: List<String> = emptyList(),
    val items: List<ApiItem> = emptyList(),
    val next: String? = null,
)

@Serializable
data class Resume(val positionSeconds: Double, val durationSeconds: Double? = null)

@Serializable
data class Episode(
    val id: String,
    val number: Int,
    val name: String? = null,
    val watched: Boolean = false,
    val inProgress: Boolean = false,
    val playPath: String? = null,
)

@Serializable
data class Chapter(val title: String, val startSeconds: Double)

@Serializable
data class GuideLine(
    val category: String,
    val severity: String? = null,
    val scenes: Int = 0,
    val seconds: Int = 0,
    val source: String = "file",
    val skippedForYou: Boolean = false,
)

@Serializable
data class GuideReport(val topic: String, val yes: Int = 0, val no: Int = 0)

@Serializable
data class Guide(val lines: List<GuideLine> = emptyList(), val reports: List<GuideReport> = emptyList(), val fromCommunity: Boolean = false)

@Serializable
data class ExtraItem(val id: String, val name: String, val durationSeconds: Double = 0.0, val playPath: String? = null)

@Serializable
data class ExtraGroup(val category: String, val items: List<ExtraItem> = emptyList())

@Serializable
data class CastMember(val name: String, val character: String? = null, val photoUrl: String? = null)

@Serializable
data class OwnershipUnit(
    val seasonId: String? = null,
    val label: String? = null,
    val iOwn: Boolean = false,
    val myShared: Boolean = false,
    val playable: Boolean = true,
)

@Serializable
data class Ownership(val claimMode: String = "review", val canChange: Boolean = true, val units: List<OwnershipUnit> = emptyList())

@Serializable
data class PlayRef(val manifestPath: String)

@Serializable
data class SeriesRef(val name: String, val position: String? = null)

/** A movie, a show or an audiobook (`type` says which); fields that don't apply to it are empty. */
@Serializable
data class Title(
    val type: String,
    val id: String,
    val name: String,
    val year: Int? = null,
    val overview: String? = null,
    val posterUrl: String? = null,
    val backdropUrl: String? = null,
    val runtimeSeconds: Int? = null,
    val genres: List<String> = emptyList(),
    val certification: String? = null,
    val libraryId: String? = null,
    val finished: Boolean = false,
    val watched: Boolean = false,
    val resume: Resume? = null,
    val play: PlayRef? = null,
    val chapters: List<Chapter> = emptyList(),
    val extras: List<ExtraGroup> = emptyList(),
    val cast: List<CastMember> = emptyList(),
    val guide: Guide? = null,
    val seasons: List<Int> = emptyList(),
    val season: Int? = null,
    val episodes: List<Episode> = emptyList(),
    val continueEpisodeId: String? = null,
    val authors: List<String> = emptyList(),
    val narrators: List<String> = emptyList(),
    val series: SeriesRef? = null,
    val ownership: Ownership? = null,
    val moreInCollections: List<MoreInCollection> = emptyList(),
)

@Serializable
data class SearchResponse(val query: String = "", val items: List<ApiItem> = emptyList())

@Serializable
data class Track(
    val id: String,
    val name: String,
    val disc: Int? = null,
    val number: Int? = null,
    val durationSeconds: Double? = null,
    val artist: String? = null,
    val playPath: String? = null,
)

@Serializable
data class ArtistRef(val id: String, val name: String)

@Serializable
data class Album(
    val id: String,
    val name: String,
    val year: Int? = null,
    val artist: ArtistRef? = null,
    val coverUrl: String? = null,
    val totalSeconds: Double = 0.0,
    val tracks: List<Track> = emptyList(),
)

@Serializable
data class Artist(val id: String, val name: String, val albums: List<ApiItem> = emptyList())

// ── Playing ──

@Serializable
data class PlaySegment(
    val index: Int,
    val url: String,
    val durationSeconds: Double,
    val startSeconds: Double,
    val inFileOffsetSeconds: Double? = null,
    val inFileEndSeconds: Double? = null,
    val container: String? = null,
)

@Serializable
data class SceneSkip(val startSeconds: Double, val endSeconds: Double, val action: String, val categories: List<String> = emptyList())

@Serializable
data class SkipSegment(val kind: String, val startSeconds: Double, val endSeconds: Double)

@Serializable
data class VersionOption(val label: String, val name: String, val height: Int? = null)

@Serializable
data class PlayManifest(
    val heartbeat: Boolean = false,
    val durationSeconds: Double,
    val segments: List<PlaySegment>,
    val resumeSeconds: Double = 0.0,
    val chapters: List<Chapter> = emptyList(),
    val skips: List<SceneSkip> = emptyList(),
    val skipSegments: List<SkipSegment> = emptyList(),
    val autoSkip: Map<String, Boolean> = emptyMap(),
    val notice: String? = null,
    val version: String? = null,
    val versions: List<VersionOption> = emptyList(),
)

@Serializable
data class AudioSegment(val index: Int, val startSeconds: Double, val durationSeconds: Double)

@Serializable
data class AudioUrl(val index: Int, val url: String)

@Serializable
data class AudiobookManifest(
    val heartbeat: Boolean = false,
    val titleId: String = "",
    val name: String = "",
    val durationSeconds: Double,
    val segments: List<AudioSegment>,
    val chapters: List<Chapter> = emptyList(),
    val resumeSeconds: Double = 0.0,
    val urls: List<AudioUrl> = emptyList(),
)

@Serializable
data class NotificationItem(val id: String, val kind: String = "", val message: String, val href: String? = null, val read: Boolean = false)

@Serializable
data class NotificationsResponse(val unread: Int = 0, val items: List<NotificationItem> = emptyList())

@Serializable
data class DeviceRow(val id: String, val label: String, val lastUsedAt: String = "", val current: Boolean = false)

@Serializable
data class DevicesResponse(val devices: List<DeviceRow> = emptyList())
