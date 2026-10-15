package com.roam.app.player

import android.content.Intent
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class PlaybackServiceTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.app.Application>()

    @Test fun startingListeningStartsTheServiceAndStoppingEndsIt() {
        val player = ExoPlayer.Builder(context).build()
        BackgroundAudio.start(context, player)
        assertSame(player, BackgroundAudio.player)
        assertEquals(PlaybackService::class.java.name, shadowOf(context as android.app.Application).nextStartedService.component?.className)
        BackgroundAudio.stop(context, player)
        assertNull(BackgroundAudio.player)
        assertNotNull(shadowOf(context as android.app.Application).nextStoppedService)
        player.release()
    }

    @Test fun theServiceWrapsThePlayerInASessionAndSwitchesToANewOne() {
        val first = ExoPlayer.Builder(context).build()
        BackgroundAudio.start(context, first)
        val controller = Robolectric.buildService(PlaybackService::class.java).create()
        val service = controller.get()
        service.onStartCommand(Intent(context, PlaybackService::class.java), 0, 1)
        assertEquals(1, service.sessions.size)
        assertSame(first, service.sessions[0].player)

        val second = ExoPlayer.Builder(context).build()
        second.setMediaItem(MediaItem.fromUri("https://example.com/a.mp3"))
        BackgroundAudio.start(context, second)
        service.onStartCommand(Intent(context, PlaybackService::class.java), 0, 2)
        assertEquals(1, service.sessions.size)
        assertSame(second, service.sessions[0].player)
        controller.destroy()
        BackgroundAudio.stop(context, second)
        first.release()
        second.release()
    }

    @Test fun swipingTheAppAwayEndsTheServiceUnlessSomethingIsPlaying() {
        val player = ExoPlayer.Builder(context).build()
        BackgroundAudio.start(context, player)
        val controller = Robolectric.buildService(PlaybackService::class.java).create()
        val service = controller.get()
        service.onStartCommand(Intent(context, PlaybackService::class.java), 0, 1)
        service.onTaskRemoved(null)
        assertTrue(shadowOf(service).isStoppedBySelf)
        BackgroundAudio.stop(context, player)
        controller.destroy()
        player.release()
    }
}
