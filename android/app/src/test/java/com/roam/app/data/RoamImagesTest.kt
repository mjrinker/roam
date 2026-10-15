package com.roam.app.data

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RoamImagesTest {
    private val base = "https://roam.example"

    @Test fun aPathIsRoamsOwnAndAWholeAddressIsLeftAlone() {
        assertEquals("https://roam.example/api/photos/p/thumb?v=1", RoamImages.resolve(base, "/api/photos/p/thumb?v=1"))
        assertEquals("https://roam.example/api/photos/p", RoamImages.resolve("https://roam.example/", "/api/photos/p"))
        assertEquals("https://image.tmdb.org/t/p/w500/x.jpg", RoamImages.resolve(base, "https://image.tmdb.org/t/p/w500/x.jpg"))
        assertEquals("//other.example/x", RoamImages.resolve(base, "//other.example/x")) // not treated as a path of ours
    }

    @Test fun theSignInGoesOnlyToRoamsOwnServer() {
        assertEquals("Bearer rdt_1", RoamImages.authorize(base, "rdt_1", "https://roam.example/api/photos/p/thumb".toHttpUrl()))
        assertNull(RoamImages.authorize(base, "rdt_1", "https://image.tmdb.org/x.jpg".toHttpUrl()))
        assertNull(RoamImages.authorize(base, "rdt_1", "https://roam.example.evil.test/x".toHttpUrl()))
        assertNull(RoamImages.authorize(base, "rdt_1", "http://roam.example/x".toHttpUrl())) // a different scheme is a different place
        assertNull(RoamImages.authorize(base, "rdt_1", "https://roam.example:8443/x".toHttpUrl()))
        assertNull(RoamImages.authorize(base, null, "https://roam.example/x".toHttpUrl())) // not signed in
        assertNull(RoamImages.authorize("not a url", "rdt_1", "https://roam.example/x".toHttpUrl()))
    }
}
