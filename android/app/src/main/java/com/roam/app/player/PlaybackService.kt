@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package com.roam.app.player

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.media3.common.Player
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * The audiobook or song being listened to, shared with [PlaybackService]. The player lives in the screen (so the playback session watching it
 * keeps working as before); while a listening screen is open the service wraps it in a media session, which is what gives the notification,
 * the lock-screen controls, headset buttons and the right to keep playing with the screen off.
 */
object BackgroundAudio {
    @Volatile
    var player: Player? = null
        private set

    fun start(context: Context, player: Player) {
        this.player = player
        ContextCompat.startForegroundService(context, Intent(context, PlaybackService::class.java))
    }

    fun stop(context: Context, player: Player) {
        if (this.player === player) this.player = null
        context.stopService(Intent(context, PlaybackService::class.java))
    }
}

class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        syncSession()
        return super.onStartCommand(intent, flags, startId)
    }

    /** Wraps the current player (a new listening screen may have replaced the one this service first saw). */
    private fun syncSession() {
        val wanted = BackgroundAudio.player
        if (session?.player === wanted) return
        session?.let {
            removeSession(it)
            it.release()
        }
        session = wanted?.let { MediaSession.Builder(this, it).build().also(::addSession) }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? {
        syncSession()
        return session
    }

    /** The app was swiped away: nothing to keep going unless it is playing. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        val p = session?.player
        if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
    }

    override fun onDestroy() {
        session?.release()
        session = null
        super.onDestroy()
    }
}
