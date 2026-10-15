import unittest

import conftest_path  # noqa: F401
from resources.lib.api import ApiError
from resources.lib.session import IDLE_TICKS, PlaybackSession


class FakeAdapter:
    """What Kodi would do, recorded: a position that the test moves, and a log of what the session asked for."""

    def __init__(self):
        self.is_playing = True
        self.pos = 0.0
        self.part = 0
        self.is_paused = False
        self.log = []
        self.skip_answer = None
        self.mute = False

    def playing(self):
        return self.is_playing

    def paused(self):
        return self.is_paused

    def time(self):
        return self.pos

    def playlist_position(self):
        return self.part

    def seek(self, s):
        self.log.append(("seek", s))
        self.pos = s

    def goto_part(self, i, local):
        self.log.append(("part", i, local))
        self.part, self.pos = i, local

    def stop(self):
        self.log.append(("stop",))
        self.is_playing = False

    def notify(self, text):
        self.log.append(("notify", text))

    def set_mute(self, on):
        self.log.append(("mute", on))
        return True

    def show_skip(self, label):
        self.log.append(("show", label))
        return self.skip_answer

    def hide_skip(self):
        pass


class FakeApi:
    def __init__(self):
        self.calls = []
        self.fail_beat = None

    def patch(self, path, body):
        self.calls.append(("patch", path, body))
        return {}

    def post(self, path, body=None):
        self.calls.append(("post", path, body))
        if path.endswith("/beat") and self.fail_beat:
            raise self.fail_beat
        return {}


def manifest(**over):
    m = {"segments": [{"startSeconds": 0, "durationSeconds": 100}, {"startSeconds": 100, "durationSeconds": 100}], "durationSeconds": 200}
    m.update(over)
    return m


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make(m=None, **kw):
    a, api, clock = FakeAdapter(), FakeApi(), Clock()
    s = PlaybackSession(m or manifest(), "episode", "ep1", api, a, clock, **kw)
    return s, a, api, clock


class Scenes(unittest.TestCase):
    def test_a_scene_to_skip_is_jumped_over_once(self):
        s, a, _api, _c = make(manifest(skips=[{"startSeconds": 10, "endSeconds": 20, "action": "skip", "categories": []}]))
        a.pos = 10.5
        s.tick()
        self.assertEqual(a.log, [("seek", 20)])
        a.log.clear()
        a.pos = 20.1
        s.tick()
        self.assertEqual(a.log, [])

    def test_a_skip_that_reaches_into_the_next_file_opens_it(self):
        s, a, _api, _c = make(manifest(skips=[{"startSeconds": 90, "endSeconds": 120, "action": "skip", "categories": []}]))
        a.pos = 95
        s.tick()
        self.assertEqual(a.log, [("part", 1, 20)])

    def test_a_scene_to_mute_switches_the_sound_off_and_back_on(self):
        s, a, _api, _c = make(manifest(skips=[{"startSeconds": 10, "endSeconds": 12, "action": "mute", "categories": []}]))
        a.pos = 10.5
        s.tick()
        s.tick()
        self.assertEqual(a.log, [("mute", True)])  # once, not every look
        a.pos = 12.5
        s.tick()
        self.assertEqual(a.log, [("mute", True), ("mute", False)])

    def test_the_setting_that_skips_muted_scenes_does_so(self):
        s, a, _api, _c = make(manifest(skips=[{"startSeconds": 10, "endSeconds": 12, "action": "mute", "categories": []}]), skip_instead_of_mute=True)
        a.pos = 10.5
        s.tick()
        self.assertEqual(a.log, [("seek", 12)])

    def test_the_sound_comes_back_if_playback_stops_in_a_muted_scene(self):
        s, a, _api, _c = make(manifest(skips=[{"startSeconds": 10, "endSeconds": 12, "action": "mute", "categories": []}]))
        a.pos = 10.5
        s.tick()
        a.is_playing = False
        for _ in range(IDLE_TICKS):
            s.tick()
        self.assertEqual(a.log[-1], ("mute", False))

    def test_a_slice_of_a_shared_file_moves_on_when_its_window_ends(self):
        m = {"segments": [{"startSeconds": 0, "durationSeconds": 40, "inFileOffsetSeconds": 60, "inFileEndSeconds": 100}, {"startSeconds": 40, "durationSeconds": 40}], "durationSeconds": 80}
        s, a, _api, _c = make(m)
        a.pos = 100.2
        s.tick()
        self.assertEqual(a.log, [("part", 1, 0)])


class SkipButtons(unittest.TestCase):
    M = dict(skipSegments=[{"kind": "intro", "startSeconds": 10, "endSeconds": 40}])

    def test_the_button_is_offered_and_pressing_it_skips(self):
        s, a, _api, _c = make(manifest(**self.M))
        a.pos = 20
        s.tick()
        self.assertEqual(a.log, [("show", "Skip intro")])
        a.skip_answer = "pressed"
        s.tick()
        self.assertIn(("seek", 40), a.log)

    def test_backing_out_of_it_means_it_is_not_offered_again_for_that_kind(self):
        s, a, _api, _c = make(manifest(**self.M))
        a.pos = 20
        a.skip_answer = "dismissed"
        s.tick()
        a.log.clear()
        a.skip_answer = None
        s.tick()
        self.assertEqual(a.log, [])

    def test_a_profile_that_skips_intros_by_itself_does_so_once(self):
        s, a, _api, _c = make(manifest(autoSkip={"intro": True}, **self.M))
        a.pos = 12
        s.tick()
        self.assertEqual(a.log, [("seek", 40)])
        a.log.clear()
        a.pos = 20  # went back into the intro on purpose
        s.tick()
        self.assertEqual(a.log, [("show", "Skip intro")])

    def test_no_button_outside_the_part(self):
        s, a, _api, _c = make(manifest(**self.M))
        a.pos = 50
        s.tick()
        self.assertEqual(a.log, [])


class Remembering(unittest.TestCase):
    def test_the_place_is_sent_every_fifteen_seconds(self):
        s, a, api, c = make()
        a.pos = 30
        s.tick()
        self.assertEqual(api.calls, [])
        c.t += 15
        a.pos = 45
        s.tick()
        self.assertEqual(api.calls, [("patch", "/api/watch-state", {"ownerKind": "episode", "ownerId": "ep1", "positionSeconds": 45, "durationSeconds": 200, "finished": False})])

    def test_stopping_early_remembers_where_and_ends_after_a_couple_of_seconds_not_at_once(self):
        s, a, api, _c = make()
        a.pos = 50
        s.tick()
        a.is_playing = False
        for _ in range(IDLE_TICKS - 1):
            self.assertTrue(s.tick())  # a gap between files looks like this
        self.assertFalse(s.tick())
        self.assertEqual(api.calls[-1][2]["positionSeconds"], 50)
        self.assertFalse(api.calls[-1][2]["finished"])
        self.assertFalse(s.tick())
        self.assertEqual(len(api.calls), 1)  # said once

    def test_a_film_watched_to_the_end_is_finished(self):
        s, a, api, _c = make()
        a.part, a.pos = 1, 95
        s.tick()
        a.is_playing = False
        for _ in range(IDLE_TICKS):
            s.tick()
        self.assertTrue(api.calls[-1][2]["finished"])
        self.assertTrue(s.finished)

    def test_playback_that_never_started_saves_nothing_so_the_old_place_survives(self):
        s, a, api, _c = make()
        a.is_playing = False
        for _ in range(IDLE_TICKS):
            s.tick()
        self.assertEqual(api.calls, [])

    def test_an_extra_keeps_no_place(self):
        a, api, c = FakeAdapter(), FakeApi(), Clock()
        s = PlaybackSession(manifest(), "extra", "x1", api, a, c)
        a.pos = 5
        s.tick()
        c.t += 20
        s.tick()
        self.assertEqual(api.calls, [])

    def test_a_save_that_fails_does_not_stop_the_film(self):
        s, a, api, c = make()
        api.patch = lambda *x: (_ for _ in ()).throw(ApiError(0, "down", "network"))
        c.t += 20
        a.pos = 5
        self.assertTrue(s.tick())


class Limit(unittest.TestCase):
    def test_it_holds_its_place_and_lets_go(self):
        s, a, api, c = make(manifest(heartbeat=True))
        c.t += 31
        a.pos = 10
        s.tick()
        self.assertIn(("post", "/api/playback/beat", {"ownerKind": "episode", "ownerId": "ep1", "paused": False}), api.calls)
        a.is_playing = False
        for _ in range(IDLE_TICKS):
            s.tick()
        self.assertEqual(api.calls[-1], ("post", "/api/playback/end", {}))

    def test_losing_the_place_stops_playback_and_says_why(self):
        s, a, api, c = make(manifest(heartbeat=True))
        api.fail_beat = ApiError(423, "The owner has withdrawn this.", "withdrawn")
        c.t += 31
        a.pos = 10
        s.tick()
        self.assertIn(("notify", "The owner has withdrawn this."), a.log)
        self.assertIn(("stop",), a.log)

    def test_no_heartbeat_when_the_server_does_not_ask_for_one(self):
        s, a, api, c = make()
        c.t += 100
        a.pos = 10
        s.tick()
        self.assertFalse([x for x in api.calls if "beat" in x[1]])


if __name__ == "__main__":
    unittest.main()
