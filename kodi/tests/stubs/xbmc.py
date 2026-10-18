"""Just enough of Kodi's xbmc module for the tests: calls are recorded, nothing is shown."""
PLAYLIST_VIDEO = 1
PLAYLIST_MUSIC = 0
calls = []
labels = {"System.FriendlyName": "Test Kodi"}
rpc_state = {"muted": False}
abort = {"after": None, "count": 0}


def getInfoLabel(name):
    return labels.get(name, "")


def getCondVisibility(name):
    return False


def executebuiltin(text):
    calls.append(("builtin", text))


def executeJSONRPC(text):
    import json
    req = json.loads(text)
    calls.append(("rpc", req["method"], req.get("params")))
    if req["method"] == "Application.GetProperties":
        return json.dumps({"result": {"muted": rpc_state["muted"]}})
    if req["method"] == "Application.SetMute":
        rpc_state["muted"] = req["params"]["mute"]
    return json.dumps({"result": "OK"})


class Monitor:
    def abortRequested(self):
        return False

    def waitForAbort(self, t=0):
        return False


class PlayList:
    instances = {}

    def __init__(self, kind):
        self.kind = kind
        self.items = []
        self.pos = 0

    def clear(self):
        self.items = []

    def add(self, url, listitem=None):
        self.items.append((url, listitem))

    def getposition(self):
        return self.pos


class Player:
    last = None

    def __init__(self):
        Player.last = self
        self.played = None

    def play(self, playlist=None, startpos=0, **kw):
        self.played = (playlist, startpos)
        calls.append(("play", len(playlist.items) if playlist else 0, startpos))

    def isPlayingVideo(self):
        return True

    def isPlayingAudio(self):
        return False

    def getTime(self):
        return 0.0

    def seekTime(self, t):
        calls.append(("seek", t))

    def stop(self):
        calls.append(("stop",))

    audio_streams = []
    subtitle_streams = []

    def getAvailableAudioStreams(self):
        return list(Player.audio_streams)

    def getAvailableSubtitleStreams(self):
        return list(Player.subtitle_streams)

    def setAudioStream(self, i):
        calls.append(("audio", i))

    def setSubtitleStream(self, i):
        calls.append(("subtitle", i))

    def showSubtitles(self, on):
        calls.append(("subtitles", on))
