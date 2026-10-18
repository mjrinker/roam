import json
import unittest

import conftest_path  # noqa: F401
import xbmc
from resources.lib import languages


class FakePlayer:
    def __init__(self, audio, subs):
        self.audio, self.subs, self.log = audio, subs, []

    def getAvailableAudioStreams(self):
        return self.audio

    def getAvailableSubtitleStreams(self):
        return self.subs

    def setAudioStream(self, i):
        self.log.append(("audio", i))

    def setSubtitleStream(self, i):
        self.log.append(("subtitle", i))

    def showSubtitles(self, on):
        self.log.append(("subtitles", on))


class Matching(unittest.TestCase):
    def test_codes_in_one_spelling(self):
        self.assertEqual(languages.normalize("FRE"), "fra")
        self.assertEqual(languages.normalize("eng"), "eng")
        self.assertIsNone(languages.normalize("English"))
        self.assertIsNone(languages.normalize(None))

    def test_finds_the_first_stream_in_a_language(self):
        self.assertEqual(languages.index_of(["eng", "spa", "spa"], "SPA"), 1)
        self.assertEqual(languages.index_of(["eng", "fre"], "fra"), 1)
        self.assertIsNone(languages.index_of(["eng"], "deu"))
        self.assertIsNone(languages.index_of(["eng"], None))

    def test_starts_in_the_profiles_languages_when_the_file_has_them(self):
        p = FakePlayer(["eng", "spa", "por"], ["eng", "spa"])
        languages.apply_prefs(p, {"audio": "spa", "subtitles": "eng"})
        self.assertEqual(p.log, [("audio", 1), ("subtitle", 0), ("subtitles", True)])

    def test_leaves_things_alone_without_a_match_or_a_preference(self):
        p = FakePlayer(["eng", "spa"], ["eng"])
        languages.apply_prefs(p, {"audio": "deu"})
        languages.apply_prefs(p, None)
        self.assertEqual(p.log, [])
        p2 = FakePlayer(["eng", "spa"], [])
        languages.apply_prefs(p2, {"audio": "eng"})  # already the first
        self.assertEqual(p2.log, [])


class Watching(unittest.TestCase):
    class Api:
        def __init__(self):
            self.puts = []

        def put(self, path, body):
            self.puts.append((path, body))

    def setUp(self):
        self.state = {"currentaudiostream": {"language": "eng"}, "subtitleenabled": False}
        self._orig = xbmc.executeJSONRPC
        xbmc.executeJSONRPC = lambda text: json.dumps({"result": self.state})

    def tearDown(self):
        xbmc.executeJSONRPC = self._orig

    def run_ticks(self, w):
        for _ in range(languages.RECHECK_TICKS):
            w.tick()

    def test_tells_roam_when_the_person_picks_another_audio_or_turns_subtitles_on_or_off(self):
        api = self.Api()
        w = languages.LanguageWatcher(api)
        w.baseline()
        self.run_ticks(w)
        self.assertEqual(api.puts, [])
        self.state["currentaudiostream"] = {"language": "spa"}
        self.run_ticks(w)
        self.assertEqual(api.puts, [("/api/viewers/current/languages", {"audio": "spa"})])
        self.state.update(subtitleenabled=True, currentsubtitle={"language": "fre"})
        self.run_ticks(w)
        self.assertEqual(api.puts[-1], ("/api/viewers/current/languages", {"subtitles": "fra"}))
        self.state["subtitleenabled"] = False
        self.run_ticks(w)
        self.assertEqual(api.puts[-1], ("/api/viewers/current/languages", {"subtitles": None}))
        self.assertEqual(len(api.puts), 3)


if __name__ == "__main__":
    unittest.main()
