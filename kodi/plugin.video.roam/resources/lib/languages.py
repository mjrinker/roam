"""The profile's audio and subtitle languages in Kodi: start in them when the file has them, and tell Roam when the person picks others."""
import json

import xbmc

ALIASES = {"fre": "fra", "ger": "deu", "chi": "zho", "dut": "nld"}
RECHECK_TICKS = 8  # the watch loop runs four times a second: look at what is selected every couple of seconds


def normalize(code):
    c = (code or "").strip().lower()
    return ALIASES.get(c, c) if len(c) == 3 and c.isalpha() else None


def index_of(streams, wanted):
    """The position of the first stream in this language (Kodi lists them as language codes), or None."""
    want = normalize(wanted)
    if not want:
        return None
    for i, s in enumerate(streams or []):
        if normalize(s) == want:
            return i
    return None


def apply_prefs(player, prefs):
    """Switch to the profile's audio language and subtitles, where the file has them."""
    prefs = prefs or {}
    audio = index_of(player.getAvailableAudioStreams(), prefs.get("audio"))
    if audio is not None and audio != 0:
        player.setAudioStream(audio)
    subs = index_of(player.getAvailableSubtitleStreams(), prefs.get("subtitles"))
    if subs is not None:
        player.setSubtitleStream(subs)
        player.showSubtitles(True)


def _properties():
    try:
        r = json.loads(xbmc.executeJSONRPC(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "Player.GetProperties", "params": {"playerid": 1, "properties": ["currentaudiostream", "currentsubtitle", "subtitleenabled"]}})))
    except ValueError:
        return {}
    return r.get("result", {})


class LanguageWatcher:
    """Notices the person choosing another audio or subtitle language in Kodi's own menu, and has Roam remember it."""

    def __init__(self, api):
        self.api = api
        self.audio = None
        self.subs = None
        self.ticks = 0

    def _state(self):
        p = _properties()
        audio = (p.get("currentaudiostream") or {}).get("language")
        subs = (p.get("currentsubtitle") or {}).get("language") if p.get("subtitleenabled") else None
        return audio, subs

    def baseline(self):
        self.audio, self.subs = self._state()

    def tick(self):
        self.ticks += 1
        if self.ticks % RECHECK_TICKS:
            return
        audio, subs = self._state()
        change = {}
        if audio != self.audio and normalize(audio):
            change["audio"] = normalize(audio)
        if subs != self.subs:
            change["subtitles"] = normalize(subs)
        self.audio, self.subs = audio, subs
        if change:
            try:
                self.api.put("/api/viewers/current/languages", change)
            except Exception:  # remembering is best effort
                pass
