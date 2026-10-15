package com.roam.app.player

import com.roam.app.data.PlayManifest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** What a session needs from the player (an ExoPlayer in the app, a fake in tests). Positions are seconds inside the item that is playing. */
interface PlayerEngine {
    val isPlaying: Boolean
    val isPaused: Boolean
    val itemIndex: Int
    val positionSeconds: Double
    fun seekInItem(seconds: Double)
    fun gotoItem(index: Int, seconds: Double)
    fun stop()
    fun setMuted(muted: Boolean)
}

/** Where a session tells Roam things (and anything else that should happen away from the player's thread). Failures are the reporter's to swallow. */
interface Reporter {
    fun saveProgress(positionSeconds: Int, durationSeconds: Int, finished: Boolean)
    /** Holds the place; [onLost] is called with the server's words if the place can no longer be held. */
    fun beat(paused: Boolean, onLost: (String) -> Unit)
    fun end()
}

/** What the screen shows on top of the picture. */
data class PlayerUi(
    val offer: SkipOffer? = null,
    /** Said once, as playing starts, then cleared by the screen. */
    val notice: String? = null,
    /** The place was lost (an owner withdrew the copy): playback has stopped and this says why. */
    val lostMessage: String? = null,
    val ended: Boolean = false,
    val finished: Boolean = false,
)

/**
 * One playback, watched over while it plays: skips and mutes scenes, offers the skip buttons, tells Roam where the person is, holds the place
 * when the server limits how many can watch, and notices when playback ends. [tick] is called about four times a second.
 */
class PlaybackSession(
    private val manifest: PlayManifest,
    private val engine: PlayerEngine,
    private val reporter: Reporter,
    private val clockMs: () -> Long,
    private val skipInsteadOfMute: Boolean = false,
    /** Playing something that keeps no place (an extra, a song). */
    private val keepsPlace: Boolean = true,
) {
    private val segments = manifest.segments
    private val duration = manifest.durationSeconds
    private val _ui = MutableStateFlow(PlayerUi(notice = manifest.notice?.takeIf { it.isNotBlank() }))
    val ui: StateFlow<PlayerUi> = _ui.asStateFlow()

    var globalSeconds = 0.0
        private set
    private var part = 0
    private var started = false
    private var idle = 0
    private var mutedByUs = false
    private var lastJump = -1000.0
    private var lastSave = clockMs()
    private var lastBeat = clockMs()
    private val autoDone = mutableSetOf<String>()
    private val dismissed = mutableSetOf<String>()
    private var over = false

    /** Returns false once playback is over. */
    fun tick(): Boolean {
        if (over) return false
        if (!engine.isPlaying) {
            // Between one file and the next the player can look stopped for a moment: only a couple of seconds of it counts as over.
            idle++
            return if (idle < IDLE_TICKS) true else stopped()
        }
        idle = 0
        started = true
        part = engine.itemIndex.coerceIn(0, segments.lastIndex)
        globalSeconds = globalTime(segments[part], engine.positionSeconds)
        scenes()
        skipButton()
        housekeeping()
        return !over
    }

    private fun scenes() {
        val scene = sceneAt(manifest.skips, globalSeconds)
        if (scene != null && scene.action == "mute" && !skipInsteadOfMute) {
            if (!mutedByUs) {
                engine.setMuted(true)
                mutedByUs = true
            }
            return
        }
        if (mutedByUs) {
            engine.setMuted(false)
            mutedByUs = false
        }
        if (scene != null && kotlin.math.abs(globalSeconds - lastJump) > 1) {
            lastJump = globalSeconds
            seekGlobal(scene.endSeconds)
        }
    }

    private fun skipButton() {
        val offer = skipOfferAt(manifest.skipSegments, globalSeconds)
        if (offer == null || offer.kind in dismissed) {
            setOffer(null)
            return
        }
        if (manifest.autoSkip[offer.kind] == true && offer.kind !in autoDone) {
            autoDone += offer.kind
            setOffer(null)
            seekGlobal(offer.toSeconds)
            return
        }
        setOffer(offer)
    }

    private fun setOffer(offer: SkipOffer?) {
        if (_ui.value.offer != offer) _ui.value = _ui.value.copy(offer = offer)
    }

    /** The person pressed the offered skip button. */
    fun pressSkip() {
        val offer = _ui.value.offer ?: return
        setOffer(null)
        seekGlobal(offer.toSeconds)
    }

    /** The person dismissed the button: it isn't offered again for that kind of part. */
    fun dismissSkip() {
        val offer = _ui.value.offer ?: return
        dismissed += offer.kind
        setOffer(null)
    }

    fun clearNotice() {
        if (_ui.value.notice != null) _ui.value = _ui.value.copy(notice = null)
    }

    fun seekGlobal(t: Double) {
        val target = t.coerceIn(0.0, (duration - 1).coerceAtLeast(0.0))
        val loc = locatePart(segments, target) ?: return
        if (loc.index == part) engine.seekInItem(loc.localSeconds) else engine.gotoItem(loc.index, loc.localSeconds)
    }

    private fun housekeeping() {
        val now = clockMs()
        if (now - lastSave >= SAVE_EVERY_MS) save(false)
        if (manifest.heartbeat && now - lastBeat >= BEAT_EVERY_MS) {
            lastBeat = now
            reporter.beat(engine.isPaused) { message ->
                _ui.value = _ui.value.copy(lostMessage = message.ifBlank { "This isn't available any more." })
                engine.stop()
            }
        }
    }

    private fun save(finished: Boolean) {
        lastSave = clockMs()
        if (keepsPlace) reporter.saveProgress(globalSeconds.toInt(), duration.toInt(), finished)
    }

    private fun stopped(): Boolean {
        over = true
        if (!started) {
            // It never began: nothing to remember, and the saved place must not be overwritten.
            _ui.value = _ui.value.copy(ended = true)
            return false
        }
        if (mutedByUs) {
            engine.setMuted(false)
            mutedByUs = false
        }
        val done = isFinished(globalSeconds, duration)
        save(done)
        if (manifest.heartbeat) reporter.end()
        _ui.value = _ui.value.copy(offer = null, ended = true, finished = done)
        return false
    }

    /** The screen was left while playing: remember where, and let go of the place. */
    fun close() {
        if (over) return
        over = true
        if (mutedByUs) engine.setMuted(false)
        if (started) {
            save(isFinished(globalSeconds, duration))
            if (manifest.heartbeat) reporter.end()
        }
        _ui.value = _ui.value.copy(ended = true, finished = started && isFinished(globalSeconds, duration))
    }

    companion object {
        const val IDLE_TICKS = 8
        const val SAVE_EVERY_MS = 15_000L
        const val BEAT_EVERY_MS = 30_000L
    }
}
