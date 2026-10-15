package com.roam.app.player

import androidx.media3.common.MimeTypes
import androidx.media3.exoplayer.ExoPlayer
import androidx.test.core.app.ApplicationProvider
import com.roam.app.data.PlayManifest
import com.roam.app.data.PlaySegment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PlayerSupportTest {
    private val manifest = PlayManifest(
        durationSeconds = 200.0,
        segments = listOf(
            PlaySegment(0, "https://box/1", 100.0, 0.0, container = "mp4"),
            PlaySegment(1, "https://box/2", 100.0, 100.0, inFileOffsetSeconds = 10.0, inFileEndSeconds = 110.0, container = "mkv"),
            PlaySegment(2, "https://box/3", 50.0, 200.0),
        ),
    )

    @Test fun oneItemPerFileWithTheContainerAsAHint() {
        val items = mediaItemsFor(manifest, "The Film")
        assertEquals(listOf("https://box/1", "https://box/2", "https://box/3"), items.map { it.localConfiguration!!.uri.toString() })
        assertEquals(listOf(MimeTypes.VIDEO_MP4, MimeTypes.VIDEO_MATROSKA, null), items.map { it.localConfiguration!!.mimeType })
        assertEquals("The Film", items[0].mediaMetadata.title)
    }

    @Test fun aSliceOfASharedFileIsPlayedAsAClip() {
        val items = mediaItemsFor(manifest, "x")
        assertEquals(0L, items[0].clippingConfiguration.startPositionMs)
        assertEquals(10_000L, items[1].clippingConfiguration.startPositionMs)
        assertEquals(110_000L, items[1].clippingConfiguration.endPositionMs)
    }

    @Test fun containersMapToTypes() {
        assertEquals(MimeTypes.VIDEO_MP4, mimeFor("MP4"))
        assertEquals(MimeTypes.VIDEO_MATROSKA, mimeFor("mkv"))
        assertEquals(MimeTypes.VIDEO_WEBM, mimeFor("webm"))
        assertNull(mimeFor("avi"))
        assertNull(mimeFor(null))
    }

    @Test fun onlyTheAudioThisDeviceCantPlayIsListed() {
        assertEquals("", AudioSupport.unsupported { true })
        val noDts = AudioSupport.unsupported { it != MimeTypes.AUDIO_DTS && it != MimeTypes.AUDIO_DTS_HD }
        assertEquals("dtsc,dtsh", noDts)
        assertTrue(AudioSupport.unsupported { false }.split(",").containsAll(listOf("ac-3", "ec-3", "dtsc", "alac")))
    }

    @Test fun theEngineMovesAroundTheItemsOfARealPlayer() {
        val player = ExoPlayer.Builder(ApplicationProvider.getApplicationContext()).build()
        try {
            val engine = ExoEngine(player)
            player.setMediaItems(mediaItemsFor(manifest, "x"))
            engine.gotoItem(2, 30.0)
            assertEquals(2, engine.itemIndex)
            assertEquals(30.0, engine.positionSeconds, 0.001)
            engine.seekInItem(12.5)
            assertEquals(12.5, engine.positionSeconds, 0.001)
            assertTrue(engine.isPaused) // playWhenReady is off until told
            engine.setMuted(true)
            assertEquals(0f, player.volume, 0f)
            engine.setMuted(false)
            assertEquals(1f, player.volume, 0f)
        } finally {
            player.release()
        }
    }
}
