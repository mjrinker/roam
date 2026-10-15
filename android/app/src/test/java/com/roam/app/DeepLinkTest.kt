package com.roam.app

import android.app.SearchManager
import android.content.Intent
import android.net.Uri
import com.roam.app.data.ApiItem
import com.roam.app.tv.rowEntries
import com.roam.app.ui.Routes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DeepLinkTest {
    private val id = "123e4567-e89b-42d3-a456-426614174000"
    private fun open(uri: String) = DeepLink.routeFor(Uri.parse(uri), "S")

    @Test fun anItemOpensItsOwnScreen() {
        assertEquals(Routes.title("S", id), open("roam://item/movie/$id"))
        assertEquals(Routes.title("S", id), open("roam://item/show/$id"))
        assertEquals(Routes.title("S", id), open("roam://item/audiobook/$id"))
        assertEquals(Routes.player("episode", id, ""), open("roam://item/episode/$id"))
        assertEquals(Routes.album("S", id), open("roam://item/album/$id"))
        assertEquals(Routes.artist("S", id), open("roam://item/artist/$id"))
    }

    @Test fun whatIsntOursOrIsMalformedOpensNothing() {
        assertNull(open("https://example.com/item/movie/$id"))
        assertNull(open("roam://item/photo/$id"))
        assertNull(open("roam://item/movie/not an id"))
        assertNull(open("roam://item/movie"))
        assertNull(open("roam://item/movie/$id/extra"))
        assertNull(open("roam://other/movie/$id"))
        assertNull(DeepLink.routeFor(Uri.parse("roam://item/movie/$id"), null)) // no server chosen yet
    }

    @Test fun aLinkBuiltForAnItemOpensThatItem() {
        val item = ApiItem("movie", id, "Film")
        assertEquals(Routes.title("S", id), open(DeepLink.uriFor(item)))
    }

    @Test fun aSpokenOrTypedSearchOpensSearchWithTheWords() {
        for (action in listOf(Intent.ACTION_SEARCH, "com.google.android.gms.actions.SEARCH_ACTION", "android.media.action.MEDIA_PLAY_FROM_SEARCH")) {
            val i = Intent(action).putExtra(SearchManager.QUERY, "  the matrix  ")
            assertEquals(Routes.search("S", "the matrix"), DeepLink.routeFor(i, "S"))
        }
        assertNull(DeepLink.routeFor(Intent(Intent.ACTION_SEARCH).putExtra(SearchManager.QUERY, "   "), "S"))
        assertNull(DeepLink.routeFor(Intent(Intent.ACTION_SEARCH), "S"))
        assertEquals(100, Uri.decode(DeepLink.routeFor(Intent(Intent.ACTION_SEARCH).putExtra(SearchManager.QUERY, "x".repeat(300)), "S")!!.substringAfter("?q=")).length)
    }

    @Test fun anIntentToViewALinkWorksAndOthersAreIgnored() {
        assertEquals(Routes.title("S", id), DeepLink.routeFor(Intent(Intent.ACTION_VIEW, Uri.parse("roam://item/movie/$id")), "S"))
        assertNull(DeepLink.routeFor(Intent(Intent.ACTION_MAIN), "S"))
        assertNull(DeepLink.routeFor(null as Intent?, "S"))
    }

    @Test fun theLauncherRowHasOnlyPlayableThingsAtMostEightAndOnlyPublicPosters() {
        val items = (1..12).map { ApiItem("movie", "m$it", "Film $it", posterUrl = "https://image.tmdb.org/$it.jpg") } +
            listOf(ApiItem("album", "a", "Album"), ApiItem("audiobook", "b", "Book", posterUrl = "/api/private/cover", square = true))
        val row = rowEntries(items)
        assertEquals(8, row.size)
        assertEquals(listOf("m1", "m2"), row.take(2).map { it.id })
        val book = rowEntries(items.filter { it.type == "audiobook" }).single()
        assertNull(book.posterUrl)
        assertEquals(true, book.square)
        assertEquals("roam://item/audiobook/b", book.link)
        assertEquals(0, rowEntries(listOf(ApiItem("album", "a", "Album"))).size)
    }
}
