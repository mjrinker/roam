package com.roam.app.player

import com.roam.app.data.PlaySegment
import com.roam.app.data.SceneSkip
import com.roam.app.data.SkipSegment

/**
 * Where things are in a video stored as one or more files played end to end (the same maths as the web, TV, Roku and Kodi players).
 * A file that is only a slice of a bigger one is played as a clip, so positions inside an item are always counted from the slice's start.
 */
data class Located(val index: Int, val localSeconds: Double)

/** The part holding global time [t], and the place in it. Times before the start or after the end are held to them. */
fun locatePart(segments: List<PlaySegment>, t: Double): Located? {
    if (segments.isEmpty()) return null
    val last = segments.lastIndex
    for ((i, seg) in segments.withIndex()) {
        if (t < seg.startSeconds + seg.durationSeconds || i == last) {
            return Located(i, (t - seg.startSeconds).coerceIn(0.0, seg.durationSeconds))
        }
    }
    return null
}

fun globalTime(seg: PlaySegment, itemPosition: Double): Double = seg.startSeconds + itemPosition

/** The scene to skip or mute that holds global time [t], or null. */
fun sceneAt(skips: List<SceneSkip>, t: Double): SceneSkip? = skips.firstOrNull { t >= it.startSeconds - 0.02 && t < it.endSeconds - 0.02 }

/** A "Skip intro" style button to offer. */
data class SkipOffer(val label: String, val toSeconds: Double, val kind: String)

fun skipOfferAt(segments: List<SkipSegment>, t: Double): SkipOffer? {
    val s = segments.firstOrNull { t >= it.startSeconds - 0.5 && t < it.endSeconds - 1 } ?: return null
    val label = when (s.kind) {
        "intro" -> "Skip intro"
        "recap" -> "Skip recap"
        "outro" -> "Skip credits"
        "preview" -> "Skip preview"
        else -> "Skip"
    }
    return SkipOffer(label, s.endSeconds, s.kind)
}

/** Whether a stopped video counts as watched: within the last 90 seconds, or 95% through. */
fun isFinished(position: Double, duration: Double): Boolean = duration > 0 && (duration - position < 90 || position >= duration * 0.95)
