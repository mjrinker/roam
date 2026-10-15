@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package com.roam.app.player

import android.content.Context
import android.media.MediaCodecList
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.exoplayer.audio.AudioCapabilities
import com.roam.app.data.PlayManifest

/** A session's view of an ExoPlayer (or any media3 Player). Positions are inside the item playing: for a clipped item, from the clip's start. */
class ExoEngine(private val player: Player) : PlayerEngine {
    override val isPlaying: Boolean get() = player.playbackState == Player.STATE_READY || player.playbackState == Player.STATE_BUFFERING
    override val isPaused: Boolean get() = !player.playWhenReady
    override val itemIndex: Int get() = player.currentMediaItemIndex
    override val positionSeconds: Double get() = player.currentPosition / 1000.0

    override fun seekInItem(seconds: Double) = player.seekTo((seconds * 1000).toLong())
    override fun gotoItem(index: Int, seconds: Double) = player.seekTo(index, (seconds * 1000).toLong())
    override fun stop() {
        player.stop()
    }

    override fun setMuted(muted: Boolean) {
        player.volume = if (muted) 0f else 1f
    }
}

/** What to tell ExoPlayer about a file whose address has no extension. */
fun mimeFor(container: String?): String? = when (container?.lowercase()) {
    "mkv", "matroska" -> MimeTypes.VIDEO_MATROSKA
    "webm" -> MimeTypes.VIDEO_WEBM
    "mp4", "m4v", "mov" -> MimeTypes.VIDEO_MP4
    else -> null
}

/** One media item per file of the video. A slice of a shared file is played as a clip, so its times start at zero like any other file's. */
fun mediaItemsFor(manifest: PlayManifest, title: String): List<MediaItem> = manifest.segments.map { seg ->
    MediaItem.Builder()
        .setUri(seg.url)
        .setMimeType(mimeFor(seg.container))
        .setMediaMetadata(MediaMetadata.Builder().setTitle(title).build())
        .apply {
            val end = seg.inFileEndSeconds
            if (end != null) {
                setClippingConfiguration(
                    MediaItem.ClippingConfiguration.Builder()
                        .setStartPositionMs(((seg.inFileOffsetSeconds ?: 0.0) * 1000).toLong())
                        .setEndPositionMs((end * 1000).toLong())
                        .build()
                )
            }
        }
        .build()
}

/** The audio formats the server may need to convert, as the codes it uses, and the player's name for each. */
object AudioSupport {
    val formats: List<Pair<String, String>> = listOf(
        "ac-3" to MimeTypes.AUDIO_AC3,
        "ec-3" to MimeTypes.AUDIO_E_AC3,
        "dtsc" to MimeTypes.AUDIO_DTS,
        "dtsh" to MimeTypes.AUDIO_DTS_HD,
        "dtsl" to MimeTypes.AUDIO_DTS_EXPRESS,
        "dtse" to MimeTypes.AUDIO_DTS_EXPRESS,
        "dtsx" to MimeTypes.AUDIO_DTS_X,
        "dtsy" to MimeTypes.AUDIO_DTS_X,
        "ac-4" to MimeTypes.AUDIO_AC4,
        "alac" to MimeTypes.AUDIO_ALAC,
    )

    /** The codes this device can't play, comma separated (what `unsupportedCodecs` takes); empty when it can play them all. */
    fun unsupported(canPlay: (mime: String) -> Boolean): String = formats.filter { (_, mime) -> !canPlay(mime) }.joinToString(",") { it.first }

    /** Can this device decode the format, or pass it on to a receiver that can? */
    fun deviceCanPlay(context: Context): (String) -> Boolean {
        val decoders = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }.flatMap { it.supportedTypes.toList() }.map { it.lowercase() }.toSet()
        val passthrough = AudioCapabilities.getCapabilities(context)
        return { mime ->
            mime.lowercase() in decoders || when (mime) {
                MimeTypes.AUDIO_AC3 -> passthrough.supportsEncoding(C.ENCODING_AC3)
                MimeTypes.AUDIO_E_AC3 -> passthrough.supportsEncoding(C.ENCODING_E_AC3)
                MimeTypes.AUDIO_DTS -> passthrough.supportsEncoding(C.ENCODING_DTS)
                MimeTypes.AUDIO_DTS_HD -> passthrough.supportsEncoding(C.ENCODING_DTS_HD)
                else -> false
            }
        }
    }
}
