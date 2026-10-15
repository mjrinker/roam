import os
import shutil
import unittest
import urllib.parse

import conftest_path  # noqa: F401
import xbmc
import xbmcgui
import xbmcplugin
from resources.lib import router
from resources.lib.api import ApiError

PROFILE = "/tmp/roam-kodi-test-profile"


class FakeApi:
    """Answers by path from a table the test fills in; an ApiError in the table is raised."""

    answers = {}
    seen = []

    def __init__(self, base, token=None, *a, **k):
        self.base, self.token = base, token

    def _answer(self, method, path, query=None):
        FakeApi.seen.append((method, path, dict(query or {})))
        a = FakeApi.answers.get((method, path))
        if a is None:
            a = FakeApi.answers.get(path)
        if isinstance(a, Exception):
            raise a
        return a if a is not None else {}

    def get(self, path, /, **q):
        return self._answer("GET", path, q)

    def post(self, path, body=None):
        return self._answer("POST", path)

    def patch(self, path, body):
        return self._answer("PATCH", path)

    def delete(self, path):
        return self._answer("DELETE", path)


def params_of(url):
    return dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))


class Base(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(PROFILE, ignore_errors=True)
        os.makedirs(PROFILE)
        xbmcplugin.reset()
        xbmc.calls.clear()
        xbmcgui.shown.clear()
        FakeApi.answers = {"/api/v1/me": {"profile": {"id": "p"}, "profiles": [{"id": "p", "name": "Ann", "hasPin": False}]}, "/api/v1/servers": {"servers": [{"id": "S", "name": "Home"}]}}
        FakeApi.seen = []
        self._orig = router.ApiClient
        router.ApiClient = FakeApi
        # Signed in already, with a server chosen.
        from resources.lib.auth import Store

        Store(PROFILE).set(token="rdt_x", server_id="S")

    def tearDown(self):
        router.ApiClient = self._orig

    def run_action(self, **params):
        query = "?" + urllib.parse.urlencode(params) if params else ""
        router.run(["plugin://plugin.video.roam/", "7", query])

    def urls(self):
        return [i["url"] for i in xbmcplugin.items]


class Lists(Base):
    def test_the_front_page(self):
        FakeApi.answers["/api/v1/servers/S/libraries"] = {"libraries": [{"id": "L1", "name": "Movies", "kind": "movies", "style": "grid"}, {"id": "L2", "name": "Books", "kind": "ebooks", "style": None}]}
        self.run_action()
        labels = [i["li"].label for i in xbmcplugin.items]
        self.assertEqual(labels, ["Continue watching", "Recently added", "Movies", "Search", "Switch profile", "Sign out"])
        self.assertTrue(all(i["folder"] for i in xbmcplugin.items))
        self.assertEqual(xbmcplugin.ended, [True])

    def test_a_grid_library_lists_movies_to_play_shows_to_open_and_a_next_page(self):
        FakeApi.answers["/api/v1/servers/S/libraries/L1/items"] = {"page": 1, "hasMore": True, "items": [
            {"type": "movie", "id": "m1", "name": "The Film", "subtitle": "2001", "posterUrl": "https://img/f.jpg", "square": False},
            {"type": "show", "id": "s1", "name": "The Show", "subtitle": "2010", "posterUrl": None, "square": False},
        ]}
        self.run_action(action="library", id="L1", style="grid", name="Movies")
        film, shw, nxt = xbmcplugin.items
        self.assertFalse(film["folder"])
        self.assertEqual(film["li"].props["IsPlayable"], "true")
        self.assertEqual(params_of(film["url"]), {"action": "play", "kind": "title", "id": "m1", "name": "The Film"})
        self.assertEqual(film["li"].label, "The Film (2001)")
        self.assertTrue(shw["folder"])
        self.assertEqual(params_of(shw["url"])["action"], "show")
        self.assertEqual(params_of(nxt["url"])["page"], "2")
        self.assertIn(("GET", "/api/v1/servers/S/libraries/L1/items", {"page": "1"}), FakeApi.seen)

    def test_folders_open_in_place_and_paging_goes_on_from_the_cursor(self):
        FakeApi.answers["/api/v1/servers/S/libraries/V/items"] = {"path": "Trips", "folders": ["2019"], "items": [], "next": "k~1"}
        self.run_action(action="library", id="V", style="folders", name="Videos", path="Trips")
        self.assertEqual(params_of(xbmcplugin.items[0]["url"])["path"], "Trips/2019")
        self.assertEqual(params_of(xbmcplugin.items[1]["url"])["after"], "k~1")

    def test_a_show_with_several_seasons_lists_them_then_the_episodes_with_the_rest_queued(self):
        FakeApi.answers["/api/v1/servers/S/titles/s1"] = {"type": "show", "seasons": [1, 2], "season": 1, "posterUrl": None, "episodes": []}
        self.run_action(action="show", id="s1", name="The Show")
        self.assertEqual([i["li"].label for i in xbmcplugin.items], ["Season 1", "Season 2"])
        xbmcplugin.reset()
        FakeApi.answers["/api/v1/servers/S/titles/s1"] = {"type": "show", "seasons": [1, 2], "season": 2, "posterUrl": None, "episodes": [
            {"id": "e1", "number": 1, "name": "Pilot", "watched": True},
            {"id": "e2", "number": 2, "name": None, "watched": False},
            {"id": "e3", "number": 3, "name": "Three", "watched": False},
        ]}
        self.run_action(action="show", id="s1", name="The Show", season="2")
        labels = [i["li"].label for i in xbmcplugin.items]
        self.assertEqual(labels, ["1. Pilot", "2. Episode 2", "3. Three"])
        self.assertEqual(params_of(xbmcplugin.items[0]["url"])["queue"], "e2,e3")
        self.assertNotIn("queue", params_of(xbmcplugin.items[2]["url"]))
        self.assertEqual(xbmcplugin.items[0]["li"].info["playcount"], 1)

    def test_search_lists_what_was_found(self):
        FakeApi.answers["/api/v1/servers/S/search"] = {"items": [{"type": "movie", "id": "m1", "name": "Film", "subtitle": None, "posterUrl": None, "square": False}, {"type": "album", "id": "a1", "name": "Songs", "subtitle": "Artist", "posterUrl": None, "square": True}]}
        self.run_action(action="search", q="fil")
        self.assertEqual([params_of(u)["action"] for u in self.urls()], ["play", "album"])
        self.assertIn(("GET", "/api/v1/servers/S/search", {"q": "fil"}), FakeApi.seen)

    def test_a_music_library_goes_artist_album_songs_that_play_without_keeping_a_place(self):
        FakeApi.answers["/api/v1/servers/S/albums/al1"] = {"coverUrl": None, "tracks": [{"id": "t1", "name": "One", "number": 1}]}
        self.run_action(action="album", id="al1")
        item = xbmcplugin.items[0]
        self.assertEqual(item["li"].label, "1. One")
        self.assertEqual(params_of(item["url"])["remember"], "0")


class SigningIn(Base):
    def setUp(self):
        super().setUp()
        from resources.lib.auth import Store

        Store(PROFILE).clear()
        self._start, self._poll = router.auth.start_code, router.auth.poll_code
        router.auth.start_code = lambda base, label: {"userCode": "K7M2P", "deviceCode": "d" * 30, "verificationUrl": "https://roam.example/link", "interval": 3, "expiresIn": 600}

    def tearDown(self):
        router.auth.start_code, router.auth.poll_code = self._start, self._poll
        super().tearDown()

    def test_it_shows_the_code_waits_for_the_approval_and_saves_the_token(self):
        answers = iter([{"status": "pending"}, {"status": "approved", "accessToken": "rdt_new"}])
        router.auth.poll_code = lambda base, code: next(answers)
        ctx = router.Context(7, {})
        self.assertTrue(router.sign_in(ctx))
        from resources.lib.auth import Store

        self.assertEqual(Store(PROFILE).get("token"), "rdt_new")
        self.assertEqual(ctx.api.token, "rdt_new")
        progress = [t for kind, t in xbmcgui.shown if kind == "progress"][0]
        self.assertIn("K7M2P", progress)
        self.assertIn("https://roam.example/link", progress)

    def test_a_code_that_runs_out_gives_up_without_saving_anything(self):
        router.auth.poll_code = lambda base, code: {"status": "expired"}
        self.assertFalse(router.sign_in(router.Context(7, {})))
        from resources.lib.auth import Store

        self.assertIsNone(Store(PROFILE).get("token"))

    def test_roam_being_down_is_said_in_words(self):
        router.auth.start_code = lambda base, label: (_ for _ in ()).throw(ApiError(0, "down", "network"))
        self.assertFalse(router.sign_in(router.Context(7, {})))
        self.assertTrue(any("Couldn't start signing in" in t for kind, t in xbmcgui.shown if kind == "ok"))


class Errors(Base):
    def test_being_signed_out_by_the_server_clears_the_saved_sign_in_and_says_so(self):
        FakeApi.answers["/api/v1/servers/S/libraries"] = ApiError(401, "Sign in required", "unauthorized")
        self.run_action()
        from resources.lib.auth import Store

        self.assertIsNone(Store(PROFILE).get("token"))
        self.assertTrue(any("signed out" in t for kind, t in xbmcgui.shown if kind == "ok"))
        self.assertEqual(xbmcplugin.ended[-1], False)

    def test_no_connection_is_explained(self):
        FakeApi.answers["/api/v1/servers/S/libraries"] = ApiError(0, "down", "network")
        self.run_action()
        self.assertTrue(any("can't be reached" in t for kind, t in xbmcgui.shown if kind == "ok"))

    def test_without_a_sign_in_it_asks_for_one_and_gives_up_if_none_comes(self):
        from resources.lib.auth import Store

        Store(PROFILE).clear()
        called = []
        original = router.sign_in
        router.sign_in = lambda ctx: called.append(1) or False
        try:
            self.run_action()
        finally:
            router.sign_in = original
        self.assertEqual(called, [1])
        self.assertEqual(xbmcplugin.items, [])
        self.assertEqual(xbmcplugin.ended, [False])

    def test_a_profile_with_a_pin_asks_for_it_and_a_wrong_one_is_explained(self):
        FakeApi.answers["/api/v1/me"] = {"profile": None, "profiles": [{"id": "d", "name": "Dad", "hasPin": True}]}
        FakeApi.answers[("POST", "/api/v1/me/profile")] = ApiError(401, "Incorrect PIN", "incorrect_pin")
        xbmcgui.answers["input"] = "0000"
        self.run_action()
        self.assertTrue(any("isn't right" in t for kind, t in xbmcgui.shown if kind == "ok"))
        self.assertEqual(xbmcplugin.items, [])


class Playing(Base):
    def manifest(self, **over):
        m = {"durationSeconds": 200, "resumeSeconds": 0, "segments": [{"startSeconds": 0, "durationSeconds": 100, "url": "https://box/1"}, {"startSeconds": 100, "durationSeconds": 100, "url": "https://box/2"}]}
        m.update(over)
        return m

    def setUp(self):
        super().setUp()
        self.watched = []
        self._watch = router.watch
        router.watch = lambda session: self.watched.append(session)
        xbmc.Player.last = None

    def tearDown(self):
        router.watch = self._watch
        super().tearDown()

    def test_every_file_is_queued_and_the_player_started_by_this_process(self):
        FakeApi.answers["/api/play/title/m1"] = self.manifest()
        self.run_action(action="play", kind="title", id="m1", name="The Film")
        self.assertEqual(xbmc.Player.last.played[1], 0)
        self.assertEqual([u for u, _ in xbmc.Player.last.played[0].items], ["https://box/1", "https://box/2"])
        self.assertEqual(xbmcplugin.resolved[0][0], False)
        self.assertEqual(len(self.watched), 1)
        self.assertIn(("GET", "/api/play/title/m1", {}), FakeApi.seen)

    def test_it_resumes_in_the_right_file_at_the_right_second(self):
        FakeApi.answers["/api/play/title/m1"] = self.manifest(resumeSeconds=130)
        self.run_action(action="play", kind="title", id="m1", name="The Film")
        playlist, start = xbmc.Player.last.played
        self.assertEqual(start, 1)
        self.assertEqual(playlist.items[1][1].props["StartOffset"], "30")
        self.assertNotIn("StartOffset", playlist.items[0][1].props)

    def test_start_over_and_a_nearly_finished_film_both_start_at_the_beginning(self):
        FakeApi.answers["/api/play/title/m1"] = self.manifest(resumeSeconds=130)
        self.run_action(action="play", kind="title", id="m1", name="F", start_over="1")
        self.assertEqual(xbmc.Player.last.played[1], 0)
        FakeApi.answers["/api/play/title/m1"] = self.manifest(resumeSeconds=190)
        self.run_action(action="play", kind="title", id="m1", name="F")
        self.assertEqual(xbmc.Player.last.played[1], 0)

    def test_when_every_copy_is_in_use_it_says_so_and_plays_nothing(self):
        FakeApi.answers["/api/play/title/m1"] = ApiError(423, "The only copy is being played right now.", "busy")
        self.run_action(action="play", kind="title", id="m1", name="F")
        self.assertIn(("ok", "The only copy is being played right now."), xbmcgui.shown)
        self.assertIsNone(xbmc.Player.last)
        self.assertEqual(xbmcplugin.resolved[0][0], False)

    def test_the_next_episode_starts_after_one_watched_to_the_end(self):
        FakeApi.answers["/api/play/episode/e1"] = self.manifest()
        router.watch = lambda session: setattr(session, "g", 198.0)
        self.run_action(action="play", kind="episode", id="e1", name="The Show", queue="e2,e3")
        builtin = [c[1] for c in xbmc.calls if c[0] == "builtin"][0]
        self.assertIn("PlayMedia(", builtin)
        self.assertEqual(params_of(builtin.split("PlayMedia(")[1].rstrip(")")), {"action": "play", "kind": "episode", "id": "e2", "name": "The Show", "queue": "e3"})

    def test_a_stopped_episode_does_not_start_the_next(self):
        FakeApi.answers["/api/play/episode/e1"] = self.manifest()
        router.watch = lambda session: setattr(session, "g", 50.0)
        self.run_action(action="play", kind="episode", id="e1", name="The Show", queue="e2")
        self.assertFalse([c for c in xbmc.calls if c[0] == "builtin"])

    def test_a_song_plays_straight_away_and_keeps_no_place(self):
        FakeApi.answers["/api/audiobooks/t1/manifest"] = {"durationSeconds": 200, "segments": [{"index": 0, "startSeconds": 0, "durationSeconds": 200}], "urls": [{"index": 0, "url": "https://box/song"}]}
        self.run_action(action="play_audio", id="t1", name="One", remember="0")
        ok, li = xbmcplugin.resolved[0]
        self.assertEqual((ok, li.path), (True, "https://box/song"))
        self.assertEqual(self.watched, [])

    def test_an_audiobook_fetches_the_parts_the_manifest_left_out_and_keeps_its_place(self):
        FakeApi.answers["/api/audiobooks/b1/manifest"] = {"durationSeconds": 7200, "resumeSeconds": 4000, "segments": [{"index": 0, "startSeconds": 0, "durationSeconds": 3600}, {"index": 1, "startSeconds": 3600, "durationSeconds": 3600}], "urls": [{"index": 0, "url": "https://box/b0"}]}
        FakeApi.answers["/api/audiobooks/b1/segments/1"] = {"index": 1, "url": "https://box/b1"}
        self.run_action(action="play_audio", id="b1", name="A Book", remember="1")
        playlist, start = xbmc.Player.last.played
        self.assertEqual([u for u, _ in playlist.items], ["https://box/b0", "https://box/b1"])
        self.assertEqual(start, 1)
        self.assertEqual(playlist.items[1][1].props["StartOffset"], "400")
        self.assertEqual((self.watched[0].kind, self.watched[0].id), ("title", "b1"))


if __name__ == "__main__":
    unittest.main()


class Details(Base):
    MOVIE = {"type": "movie", "name": "The Film", "year": 2001, "certification": "PG", "runtimeSeconds": 5400, "genres": ["Drama", "Comedy"], "overview": "A story about a film.",
             "imdbRating": 7.5, "rottenTomatoesScore": 88, "posterUrl": "https://img/f.jpg",
             "cast": [{"name": "A. Actor", "character": "The Hero"}, {"name": "B. Actor"}],
             "chapters": [{"title": "Opening", "startSeconds": 0}, {"title": "The Chase", "startSeconds": 3725}],
             "extras": [{"category": "behind_the_scenes", "items": [{"id": "x1", "name": "Making of", "durationSeconds": 600}]}, {"category": "trailer", "items": []}],
             "guide": {"lines": [{"category": "violence", "severity": "high", "scenes": 2, "skippedForYou": True}, {"category": "language", "scenes": 1}],
                       "reports": [{"topic": "a dog dies", "yes": 5, "no": 1}], "fromCommunity": True}}

    def texts(self):
        return [t for kind, t in xbmcgui.shown if kind == "text"]

    def test_the_details_say_what_the_film_is_who_is_in_it_and_what_the_guide_says(self):
        FakeApi.answers["/api/v1/servers/S/titles/m1"] = self.MOVIE
        self.run_action(action="info", id="m1")
        text = self.texts()[0]
        for part in ("The Film", "2001 · PG · 1:30:00", "Drama, Comedy", "IMDb 7.5", "Rotten Tomatoes 88%", "A story about a film.", "A. Actor as The Hero", "B. Actor",
                     "Violence (high, 2 scenes)  - skipped for you", "Language (1 scene)", "a dog dies: 5 yes, 1 no", "Powered by DoesTheDogDie.com"):
            self.assertIn(part, text)

    def test_a_title_with_little_to_say_still_opens(self):
        FakeApi.answers["/api/v1/servers/S/titles/m1"] = {"type": "movie", "name": "Bare"}
        self.run_action(action="info", id="m1")
        self.assertEqual(self.texts(), ["Bare\n"])
        self.assertNotIn("DoesTheDogDie", self.texts()[0])

    def test_movies_and_shows_offer_the_details_from_their_menu(self):
        FakeApi.answers["/api/v1/servers/S/libraries/L1/items"] = {"page": 1, "hasMore": False, "items": [
            {"type": "movie", "id": "m1", "name": "The Film", "subtitle": "2001"}, {"type": "show", "id": "s1", "name": "The Show"}]}
        self.run_action(action="library", id="L1", style="grid", name="Movies")
        film, shw = xbmcplugin.items
        menus = [label for label, _ in film["li"].context]
        self.assertEqual(menus, ["Play from the beginning", "Roam: details", "Roam: chapters", "Roam: extras"])
        self.assertEqual([label for label, _ in shw["li"].context], ["Roam: details"])

    def test_chapters_play_from_where_they_start(self):
        FakeApi.answers["/api/v1/servers/S/titles/m1"] = self.MOVIE
        self.run_action(action="chapters", id="m1", name="The Film")
        self.assertEqual([i["li"].label for i in xbmcplugin.items], ["0:00  Opening", "1:02:05  The Chase"])
        self.assertEqual(params_of(xbmcplugin.items[1]["url"]), {"action": "play", "kind": "title", "id": "m1", "name": "The Film", "start_at": "3725"})

    def test_extras_are_listed_by_kind_and_play_as_extras(self):
        FakeApi.answers["/api/v1/servers/S/titles/m1"] = self.MOVIE
        self.run_action(action="extras", id="m1", name="The Film")
        self.assertEqual([i["li"].label for i in xbmcplugin.items], ["Behind the scenes: Making of (10:00)"])
        self.assertEqual(params_of(xbmcplugin.items[0]["url"])["kind"], "extra")

    def test_nothing_to_list_is_said_in_words(self):
        FakeApi.answers["/api/v1/servers/S/titles/m1"] = {"type": "movie", "name": "Bare"}
        self.run_action(action="chapters", id="m1", name="Bare")
        self.run_action(action="extras", id="m1", name="Bare")
        said = [t for kind, t in xbmcgui.shown if kind == "ok"]
        self.assertEqual(said, ["This has no chapters.", "This has no extras."])
        self.assertEqual(xbmcplugin.items, [])


class ChapterStart(Playing):
    def test_a_chapter_starts_in_the_right_file_at_the_right_second_whatever_was_saved(self):
        FakeApi.answers["/api/play/title/m1"] = self.manifest(resumeSeconds=10)
        self.run_action(action="play", kind="title", id="m1", name="F", start_at="130")
        playlist, start = xbmc.Player.last.played
        self.assertEqual(start, 1)
        self.assertEqual(playlist.items[1][1].props["StartOffset"], "30")
        self.run_action(action="play", kind="title", id="m1", name="F", start_at="junk")
        self.assertEqual(xbmc.Player.last.played[1], 0)
