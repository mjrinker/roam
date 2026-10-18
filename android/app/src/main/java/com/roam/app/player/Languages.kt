@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package com.roam.app.player

import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import java.util.Locale

/** One audio or subtitle track the file holds, as the player lists it. */
data class LanguageChoice(
    val label: String,
    val language: String?,
    val selected: Boolean,
    val supported: Boolean,
    /** Which of the player's track groups, and which track in it, this is. */
    val group: Int,
    val index: Int,
)

data class LanguageChoices(val audio: List<LanguageChoice>, val subtitles: List<LanguageChoice>, val subtitlesOn: Boolean)

/** A language code as a person reads it: "spa" or "es" becomes "Spanish". */
fun languageName(code: String?): String? {
    if (code.isNullOrBlank() || code == "und") return null
    val name = Locale.forLanguageTag(code).getDisplayLanguage(Locale.ENGLISH)
    return name.takeIf { it.isNotBlank() && !it.equals(code, ignoreCase = true) }?.replaceFirstChar { it.uppercase() } ?: code.uppercase()
}

private fun channelsWord(n: Int) = when (n) {
    1 -> "Mono"
    2 -> "Stereo"
    6 -> "5.1"
    8 -> "7.1"
    else -> if (n > 0) "$n channels" else ""
}

/** The audio and subtitle tracks of what is playing now. A track the file named itself keeps its name; otherwise language and channels. */
fun languageChoices(tracks: Tracks, subtitlesDisabled: Boolean = false): LanguageChoices {
    val audio = mutableListOf<LanguageChoice>()
    val subs = mutableListOf<LanguageChoice>()
    tracks.groups.forEachIndexed { g, group ->
        for (i in 0 until group.length) {
            val f = group.getTrackFormat(i)
            val language = languageName(f.language)
            when (group.type) {
                C.TRACK_TYPE_AUDIO -> {
                    val label = f.label?.takeIf { it.isNotBlank() } ?: listOfNotNull(language ?: "Audio", channelsWord(f.channelCount).takeIf { it.isNotEmpty() }).joinToString(" ")
                    audio += LanguageChoice(label, f.language, group.isTrackSelected(i), group.isTrackSupported(i), g, i)
                }
                C.TRACK_TYPE_TEXT -> subs += LanguageChoice(f.label?.takeIf { it.isNotBlank() } ?: language ?: "Subtitles", f.language, group.isTrackSelected(i), group.isTrackSupported(i), g, i)
            }
        }
    }
    return LanguageChoices(audio, subs, subtitlesOn = !subtitlesDisabled && subs.any { it.selected })
}

/** Plays this audio track instead of the current one. */
fun chooseAudio(player: Player, choice: LanguageChoice) {
    val group = player.currentTracks.groups.getOrNull(choice.group) ?: return
    player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, choice.index)).build()
}

/** Shows this subtitle track, or (null) none. */
fun chooseSubtitles(player: Player, choice: LanguageChoice?) {
    val params = player.trackSelectionParameters.buildUpon()
    if (choice == null) {
        params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
    } else {
        val group = player.currentTracks.groups.getOrNull(choice.group) ?: return
        params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, choice.index))
    }
    player.trackSelectionParameters = params.build()
}

/** Start in this profile's languages: the audio if the file has it, and subtitles in that language if it has those. */
fun applyLanguagePrefs(player: Player, audio: String?, subtitles: String?) {
    val params = player.trackSelectionParameters.buildUpon()
    if (audio != null) params.setPreferredAudioLanguage(audio)
    if (subtitles != null) params.setPreferredTextLanguage(subtitles).setIgnoredTextSelectionFlags(0).setSelectUndeterminedTextLanguage(false)
    player.trackSelectionParameters = params.build()
}
