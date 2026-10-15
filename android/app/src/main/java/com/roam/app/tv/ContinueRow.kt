package com.roam.app.tv

import android.content.Context
import android.net.Uri
import androidx.tvprovider.media.tv.TvContractCompat
import androidx.tvprovider.media.tv.WatchNextProgram
import com.roam.app.DeepLink
import com.roam.app.data.ApiItem

/** Puts what the person was watching on the Android TV launcher's "Play next" row. (Does nothing off a TV, or when the launcher refuses.) */
interface ContinuePublisher {
    fun publish(items: List<ApiItem>, base: String)
}

object NoContinueRow : ContinuePublisher {
    override fun publish(items: List<ApiItem>, base: String) = Unit
}

/** What goes into one entry of the row (pure, so it can be checked without a TV). */
data class RowEntry(val id: String, val title: String, val posterUrl: String?, val link: String, val square: Boolean)

fun rowEntries(items: List<ApiItem>, limit: Int = 8): List<RowEntry> =
    items.filter { it.type == "movie" || it.type == "episode" || it.type == "audiobook" }.take(limit)
        .map { RowEntry(it.id, it.name, it.posterUrl?.takeIf { u -> u.startsWith("https://") }, DeepLink.uriFor(it), it.square) } // only public posters: the launcher can't send the sign-in

// The program builders are marked library-internal by their authors but are the documented way to fill the Android TV home row.
@android.annotation.SuppressLint("RestrictedApi")
class TvContinueRow(private val context: Context) : ContinuePublisher {
    override fun publish(items: List<ApiItem>, base: String) {
        val resolver = context.contentResolver
        try {
            // The provider only lets an app touch its own entries: replace them all with the current ones.
            resolver.delete(TvContractCompat.WatchNextPrograms.CONTENT_URI, null, null)
            for (e in rowEntries(items)) {
                val program = WatchNextProgram.Builder()
                    .setType(TvContractCompat.WatchNextPrograms.TYPE_MOVIE)
                    .setWatchNextType(TvContractCompat.WatchNextPrograms.WATCH_NEXT_TYPE_CONTINUE)
                    .setLastEngagementTimeUtcMillis(System.currentTimeMillis())
                    .setTitle(e.title)
                    .setInternalProviderId(e.id)
                    .setPosterArtAspectRatio(if (e.square) TvContractCompat.PreviewPrograms.ASPECT_RATIO_1_1 else TvContractCompat.PreviewPrograms.ASPECT_RATIO_2_3)
                    .setIntentUri(Uri.parse(e.link))
                e.posterUrl?.let { program.setPosterArtUri(Uri.parse(it)) }
                resolver.insert(TvContractCompat.WatchNextPrograms.CONTENT_URI, program.build().toContentValues())
            }
        } catch (_: Exception) {
            // no launcher row on this device (or the permission was refused): it is only a convenience
        }
    }
}
