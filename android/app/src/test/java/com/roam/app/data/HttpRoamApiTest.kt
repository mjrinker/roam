package com.roam.app.data

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class HttpRoamApiTest {
    private lateinit var server: MockWebServer
    private var token: String? = "rdt_abc"
    private lateinit var api: HttpRoamApi

    @Before fun start() {
        server = MockWebServer().apply { start() }
        api = HttpRoamApi({ server.url("/").toString() }, { token })
    }

    @After fun stop() = server.shutdown()

    private fun reply(body: String, code: Int = 200) = server.enqueue(MockResponse().setResponseCode(code).setBody(body))

    @Test fun signsRequestsWithTheTokenAndReadsTheMe() = runBlocking {
        reply("""{"account":{"id":"a","email":"x@y.z"},"profile":null,"profiles":[{"id":"p1","name":"Ann","hasPin":true}],"extraField":1}""")
        val me = api.me()
        val req = server.takeRequest()
        assertEquals("/api/v1/me", req.path)
        assertEquals("Bearer rdt_abc", req.getHeader("Authorization"))
        assertNull(me.profile)
        assertEquals(listOf("Ann"), me.profiles.map { it.name })
        assertTrue(me.profiles[0].hasPin)
    }

    @Test fun sendsNoTokenWhenThereIsNone() = runBlocking {
        token = null
        reply("""{"servers":[{"id":"s","name":"Home","role":"viewer"}]}""")
        assertEquals("Home", api.servers().single().name)
        assertNull(server.takeRequest().getHeader("Authorization"))
    }

    @Test fun startsAndPollsAPairing() = runBlocking {
        token = null
        reply("""{"userCode":"K7M2P","deviceCode":"dev","verificationUrl":"https://roam.example/link","verificationUrlComplete":"https://roam.example/link?code=K7M2P","expiresIn":600,"interval":3}""")
        val start = api.startDevice("Living room")
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("""{"label":"Living room"}""", req.body.readUtf8())
        assertEquals("K7M2P", start.userCode)
        reply("""{"status":"approved","accessToken":"rdt_new","tokenType":"Bearer","profiles":[],"profileSelected":true}""")
        val poll = api.pollDevice("dev")
        assertEquals("""{"deviceCode":"dev"}""", server.takeRequest().body.readUtf8())
        assertEquals(PollResult("approved", "rdt_new", true), poll)
    }

    @Test fun choosesAProfileWithAPinOnlyWhenGiven() = runBlocking {
        reply("""{"ok":true}""")
        reply("""{"ok":true}""")
        api.chooseProfile("v1", "1234")
        api.chooseProfile("v2", null)
        assertEquals("""{"viewerId":"v1","pin":"1234"}""", server.takeRequest().body.readUtf8())
        assertEquals("""{"viewerId":"v2"}""", server.takeRequest().body.readUtf8())
    }

    @Test fun anErrorCarriesRoamsWordsAndCode() = runBlocking {
        reply("""{"error":"Incorrect PIN","code":"incorrect_pin"}""", 401)
        try {
            api.chooseProfile("v1", "0000")
            fail("expected an error")
        } catch (e: ApiException) {
            assertEquals(401, e.status)
            assertEquals("Incorrect PIN", e.message)
            assertEquals("incorrect_pin", e.code)
        }
    }

    @Test fun aBusyTitleIsA423WithWords() = runBlocking {
        reply("""{"error":"The only copy is being played right now.","code":"busy","unit":{"titleId":"t","seasonId":null},"watching":false}""", 423)
        try {
            api.play("title", "t")
            fail("expected an error")
        } catch (e: ApiException) {
            assertEquals(423, e.status)
            assertEquals("busy", e.code)
            assertEquals("The only copy is being played right now.", e.message)
        }
    }

    @Test fun noConnectionIsStatusZero() = runBlocking {
        server.shutdown()
        try {
            api.me()
            fail("expected an error")
        } catch (e: ApiException) {
            assertEquals(0, e.status)
            assertEquals("network", e.code)
        }
    }

    @Test fun anAnswerThatIsNotJsonIsAnErrorNotACrash() = runBlocking {
        reply("<html>Bad gateway</html>", 502)
        try {
            api.libraries("s")
            fail("expected an error")
        } catch (e: ApiException) {
            assertEquals(502, e.status)
            assertEquals("Roam answered 502.", e.message)
        }
    }

    @Test fun readsAGridPageAndAFolderPage() = runBlocking {
        reply("""{"library":{"id":"L"},"page":2,"hasMore":true,"items":[{"type":"movie","id":"m","name":"Film","subtitle":"2001","posterUrl":"https://i/p.jpg","square":false}]}""")
        val grid = api.items("S", "L", page = 2)
        assertEquals("/api/v1/servers/S/libraries/L/items?page=2", server.takeRequest().path)
        assertTrue(grid.hasMore)
        assertEquals("Film", grid.items.single().name)
        reply("""{"path":"Trips","folders":["2019"],"items":[],"next":"k~1"}""")
        val folder = api.items("S", "V", path = "Trips/2019", after = "k~0")
        assertEquals("/api/v1/servers/S/libraries/V/items?path=Trips%2F2019&after=k%7E0", server.takeRequest().path)
        assertEquals(listOf("2019"), folder.folders)
        assertEquals("k~1", folder.next)
    }

    @Test fun readsPhotosPlaylistsAndSetsAFavourite() = runBlocking {
        reply("""{"items":[{"type":"photo","id":"p1","name":"IMG","posterUrl":"/api/photos/p1/thumb?v=1","square":true}],"next":"123~x"}""")
        val page = api.photos("S", "L", view = "favorites", path = null, after = "1~a")
        assertEquals("/api/v1/servers/S/libraries/L/items?view=favorites&after=1%7Ea", server.takeRequest().path)
        assertEquals("/api/photos/p1/thumb?v=1", page.items.single().posterUrl)
        assertEquals("123~x", page.next)
        reply("""{"id":"p1","type":"photo","name":"IMG","takenAt":"2026-01-02T00:00:00.000Z","favorite":true,"imagePath":"/api/photos/p1/preview","prev":null,"next":{"type":"clip","id":"c1"}}""")
        val photo = api.photo("S", "p1", "album")
        assertEquals("/api/v1/servers/S/photos/p1?from=album", server.takeRequest().path)
        assertTrue(photo.favorite)
        assertEquals(PhotoRef("clip", "c1"), photo.next)
        reply("{}")
        api.setFavorite("p1", true)
        val on = server.takeRequest()
        assertEquals("PUT /api/photos/p1/favorite", "${on.method} ${on.path}")
        reply("{}")
        api.setFavorite("p1", false)
        assertEquals("DELETE", server.takeRequest().method)
        reply("""{"playlists":[{"id":"P","name":"Fri","itemCount":2,"ownerName":"Matt","canAdd":true}]}""")
        assertEquals("Fri", api.playlists("S").single().name)
        assertEquals("/api/v1/servers/S/playlists", server.takeRequest().path)
        reply("""{"playlist":{"id":"P","name":"Fri"},"items":[{"entryId":"e","type":"episode","id":"x","name":"Ep","playable":true}],"next":"1024~z"}""")
        val list = api.playlist("S", "P", after = "1~y")
        assertEquals("/api/v1/servers/S/playlists/P?after=1%7Ey", server.takeRequest().path)
        assertEquals("1024~z", list.next)
    }

    @Test fun registersAndDropsThePushToken() = runBlocking {
        reply("""{"ok":true}""")
        api.registerPush("fcm-token-123")
        val put = server.takeRequest()
        assertEquals("PUT /api/v1/device/push", "${put.method} ${put.path}")
        assertEquals("""{"token":"fcm-token-123"}""", put.body.readUtf8())
        assertEquals("Bearer rdt_abc", put.getHeader("Authorization"))
        reply("""{"ok":true}""")
        api.unregisterPush()
        assertEquals("DELETE", server.takeRequest().method)
    }

    @Test fun readsAMovieWithItsExtras() = runBlocking {
        reply(
            """{"type":"movie","id":"m","name":"The Film","year":2001,"runtimeSeconds":5400,"genres":["Drama"],"resume":{"positionSeconds":1800,"durationSeconds":5400},
               "play":{"manifestPath":"/api/play/title/m"},"chapters":[{"title":"One","startSeconds":0},{"title":"Two","startSeconds":2000}],
               "guide":{"lines":[{"category":"violence","severity":"high","scenes":1,"seconds":20,"source":"file","skippedForYou":true}],"reports":[],"fromCommunity":false},
               "extras":[{"category":"trailers","items":[{"id":"x","name":"Teaser","durationSeconds":90,"playPath":"/api/play/extra/x"}]}],"cast":[{"name":"A","character":"B","photoUrl":null}],"ownership":null}"""
        )
        val t = api.title("S", "m")
        assertEquals("/api/v1/servers/S/titles/m", server.takeRequest().path)
        assertEquals(1800.0, t.resume?.positionSeconds)
        assertEquals(2, t.chapters.size)
        assertTrue(t.guide!!.lines.single().skippedForYou)
        assertEquals("Teaser", t.extras.single().items.single().name)
        assertNull(t.ownership)
    }

    @Test fun readsAShowWithASeason() = runBlocking {
        reply("""{"type":"show","id":"s","name":"The Show","seasons":[1,2],"season":2,"episodes":[{"type":"episode","id":"e1","number":1,"name":null,"watched":true,"inProgress":false,"playPath":"/api/play/episode/e1"}],"continueEpisodeId":"e1"}""")
        val t = api.title("S", "s", season = 2)
        assertEquals("/api/v1/servers/S/titles/s?season=2", server.takeRequest().path)
        assertEquals(listOf(1, 2), t.seasons)
        assertTrue(t.episodes.single().watched)
        assertNull(t.episodes.single().name)
    }

    @Test fun readsAPlayManifestWithEverythingItCarries() = runBlocking {
        reply(
            """{"heartbeat":true,"durationSeconds":200,"resumeSeconds":130,"segments":[{"index":0,"url":"https://box/1","durationSeconds":100,"startSeconds":0,"container":"mp4"},
               {"index":1,"url":"https://box/2","durationSeconds":100,"startSeconds":100,"inFileOffsetSeconds":10,"inFileEndSeconds":110}],
               "skips":[{"startSeconds":5,"endSeconds":9,"action":"mute","categories":["language"]}],"skipSegments":[{"kind":"intro","startSeconds":1,"endSeconds":8}],
               "autoSkip":{"intro":true},"notice":"hello","versions":[{"label":"4k","name":"4K","height":2160}],"expiresAt":"2099-01-01T00:00:00Z","canMark":false}"""
        )
        val m = api.play("title", "t", unsupportedCodecs = "dtsc,dtsh")
        assertEquals("/api/play/title/t?unsupportedCodecs=dtsc%2Cdtsh", server.takeRequest().path)
        assertTrue(m.heartbeat)
        assertEquals(110.0, m.segments[1].inFileEndSeconds!!, 0.0)
        assertEquals("mp4", m.segments[0].container)
        assertEquals("mute", m.skips.single().action)
        assertEquals(true, m.autoSkip["intro"])
        assertEquals("hello", m.notice)
    }

    @Test fun anEmptyUnsupportedListLeavesTheParameterOut() = runBlocking {
        reply("""{"durationSeconds":10,"segments":[]}""")
        api.play("episode", "e")
        assertEquals("/api/play/episode/e", server.takeRequest().path)
    }

    @Test fun savesProgressAndHoldsAPlace() = runBlocking {
        reply("""{}""")
        reply("""{"ok":true}""")
        reply("""{"ok":true}""")
        api.saveProgress("episode", "e", 1234, 2700, false)
        api.beat("episode", "e", true)
        api.endPlay()
        val save = server.takeRequest()
        assertEquals("PATCH", save.method)
        assertEquals("/api/watch-state", save.path)
        assertEquals("""{"ownerKind":"episode","ownerId":"e","positionSeconds":1234,"durationSeconds":2700,"finished":false}""", save.body.readUtf8())
        assertEquals("""{"ownerKind":"episode","ownerId":"e","paused":true}""", server.takeRequest().body.readUtf8())
        assertEquals("/api/playback/end", server.takeRequest().path)
    }

    @Test fun anAudiobookManifestAndItsLaterPartUrls() = runBlocking {
        reply("""{"titleId":"b","name":"Book","durationSeconds":7200,"resumeSeconds":4000,"segments":[{"index":0,"startSeconds":0,"durationSeconds":3600},{"index":1,"startSeconds":3600,"durationSeconds":3600}],"urls":[{"index":0,"url":"https://box/b0","expiresAt":"x"}]}""")
        reply("""{"index":1,"url":"https://box/b1","expiresAt":"x"}""")
        val m = api.audiobook("b")
        assertEquals(2, m.segments.size)
        assertEquals("https://box/b1", api.audiobookSegmentUrl("b", 1))
        server.takeRequest() // the manifest
        assertEquals("/api/audiobooks/b/segments/1", server.takeRequest().path)
    }

    @Test fun signsOutAndSignsOutADevice() = runBlocking {
        reply("""{"ok":true}""")
        reply("""{"ok":true}""")
        api.signOut()
        api.signOutDevice("d1")
        val a = server.takeRequest()
        assertEquals("DELETE", a.method)
        assertEquals("/api/v1/session", a.path)
        assertEquals("/api/v1/devices/d1", server.takeRequest().path)
    }

    @Test fun anInvalidServerAddressIsAnErrorInWords() = runBlocking {
        val bad = HttpRoamApi({ "not a url" }, { null })
        try {
            bad.me()
            fail("expected an error")
        } catch (e: ApiException) {
            assertFalse(e.message.isBlank())
            assertEquals(0, e.status)
        }
    }
}
