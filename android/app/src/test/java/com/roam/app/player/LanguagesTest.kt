@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package com.roam.app.player

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import com.google.common.collect.ImmutableList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class LanguagesTest {
    private fun audio(language: String, channels: Int, label: String? = null) =
        Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage(language).setChannelCount(channels).setLabel(label).build()

    private fun text(language: String) = Format.Builder().setSampleMimeType(MimeTypes.TEXT_VTT).setLanguage(language).build()

    private fun group(vararg formats: Format, selected: Int = 0) =
        Tracks.Group(TrackGroup(*formats), false, IntArray(formats.size) { C.FORMAT_HANDLED }, BooleanArray(formats.size) { it == selected })

    @Test fun listsAudioAndSubtitlesWithReadableNames() {
        val tracks = Tracks(ImmutableList.of(group(audio("eng", 6), audio("spa", 2, "Spanish (commentary)"), selected = 0), group(text("fra"), selected = -1)))
        val c = languageChoices(tracks)
        assertEquals(listOf("English 5.1", "Spanish (commentary)"), c.audio.map { it.label })
        assertEquals(listOf(true, false), c.audio.map { it.selected })
        assertEquals(listOf("French"), c.subtitles.map { it.label })
        assertFalse(c.subtitlesOn)
    }

    @Test fun subtitlesCountAsOnOnlyWhenOneIsShownAndTheyWereNotTurnedOff() {
        val tracks = Tracks(ImmutableList.of(group(text("eng"), selected = 0)))
        assertTrue(languageChoices(tracks).subtitlesOn)
        assertFalse(languageChoices(tracks, subtitlesDisabled = true).subtitlesOn)
    }

    @Test fun languageNamesComeFromCodesAndUnknownOnesAreNotMadeUp() {
        assertEquals("Spanish", languageName("spa"))
        assertEquals("Spanish", languageName("es"))
        assertNull(languageName("und"))
        assertNull(languageName(null))
    }
}
