package com.roam.app.player

import com.roam.app.data.PlaySegment
import com.roam.app.data.SceneSkip
import com.roam.app.data.SkipSegment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun seg(start: Double, duration: Double) = PlaySegment(index = 0, url = "u", durationSeconds = duration, startSeconds = start)

class TimelineTest {
    private val parts = listOf(seg(0.0, 100.0), seg(100.0, 50.0))

    @Test fun findsThePartAndThePlaceInIt() {
        assertEquals(Located(0, 30.0), locatePart(parts, 30.0))
        assertEquals(Located(1, 0.0), locatePart(parts, 100.0))
        assertEquals(Located(1, 20.0), locatePart(parts, 120.0))
    }

    @Test fun holdsTimesBeforeTheStartAndAfterTheEnd() {
        assertEquals(Located(0, 0.0), locatePart(parts, -5.0))
        assertEquals(Located(1, 50.0), locatePart(parts, 999.0))
        assertNull(locatePart(emptyList(), 5.0))
    }

    @Test fun globalTimeAddsThePartsBefore() = assertEquals(120.0, globalTime(parts[1], 20.0), 0.0)

    @Test fun scenesHaveEdges() {
        val skips = listOf(SceneSkip(10.0, 20.0, "skip"))
        assertNull(sceneAt(skips, 9.9))
        assertNotNull(sceneAt(skips, 10.0))
        assertNotNull(sceneAt(skips, 19.9))
        assertNull(sceneAt(skips, 20.0))
        assertNull(sceneAt(emptyList(), 5.0))
    }

    @Test fun theSkipButtonIsNamedByKindAndNotOfferedInTheLastSecond() {
        val segs = listOf(SkipSegment("intro", 60.0, 90.0), SkipSegment("outro", 2500.0, 2600.0))
        assertNull(skipOfferAt(segs, 30.0))
        assertEquals(SkipOffer("Skip intro", 90.0, "intro"), skipOfferAt(segs, 75.0))
        assertEquals("Skip credits", skipOfferAt(segs, 2550.0)?.label)
        assertNull(skipOfferAt(segs, 89.5))
    }

    @Test fun whatCountsAsWatched() {
        assertTrue(isFinished(5340.0, 5400.0))
        assertTrue(isFinished(5200.0, 5400.0))
        assertFalse(isFinished(1000.0, 5400.0))
        assertFalse(isFinished(10.0, 0.0))
    }
}
