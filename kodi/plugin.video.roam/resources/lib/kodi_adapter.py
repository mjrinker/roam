"""What the playback session needs from Kodi, in Kodi's own calls. (Kept apart from session.py so that file can be tested without Kodi.)"""
import json

import xbmc
import xbmcgui


class SkipDialog(xbmcgui.WindowXMLDialog):
    """A small button over the corner of the picture. `answer` becomes "pressed" when it's chosen, or "dismissed" when it's backed out of."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.label = ""
        self.answer = None

    def onInit(self):
        self.getControl(10).setLabel(self.label)
        self.setFocusId(10)

    def onClick(self, control_id):
        if control_id == 10:
            self.answer = "pressed"
            self.close()

    def onAction(self, action):
        if action.getId() in (xbmcgui.ACTION_PREVIOUS_MENU, xbmcgui.ACTION_NAV_BACK):
            self.answer = "dismissed"
            self.close()


class KodiAdapter:
    def __init__(self, player, playlist, addon_path):
        self.player = player
        self.playlist = playlist
        self.addon_path = addon_path
        self.dialog = None
        self.prior_mute = None

    def playing(self):
        return self.player.isPlayingVideo() or self.player.isPlayingAudio()

    def paused(self):
        return bool(xbmc.getCondVisibility("Player.Paused"))

    def time(self):
        try:
            return float(self.player.getTime())
        except RuntimeError:
            return 0.0

    def playlist_position(self):
        return self.playlist.getposition()

    def seek(self, seconds):
        self.player.seekTime(float(seconds))

    def goto_part(self, index, local_seconds):
        """Starts another file of the video (they were queued after the first) and moves to a place in it."""
        self.player.play(self.playlist, startpos=index)
        monitor = xbmc.Monitor()
        for _ in range(100):  # up to ten seconds for it to start
            if monitor.waitForAbort(0.1) or self.playing():
                break
        if local_seconds > 1:
            self.player.seekTime(float(local_seconds))

    def stop(self):
        self.player.stop()

    def notify(self, text):
        xbmcgui.Dialog().notification("Roam", text, xbmcgui.NOTIFICATION_INFO, 6000)

    def set_mute(self, on):
        """Switches the sound off (and back on), without undoing a mute the person made themselves. Returns whether it did anything."""
        state = self._rpc("Application.GetProperties", {"properties": ["muted"]})
        was = bool(state.get("result", {}).get("muted"))
        if on:
            if was:
                return False
            self._rpc("Application.SetMute", {"mute": True})
            return True
        self._rpc("Application.SetMute", {"mute": False})
        return True

    @staticmethod
    def _rpc(method, params):
        try:
            return json.loads(xbmc.executeJSONRPC(json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})))
        except ValueError:
            return {}

    def show_skip(self, label):
        """Shows the button (once) and says what has happened to it: None while it is up, "pressed", or "dismissed"."""
        if self.dialog is None:
            self.dialog = SkipDialog("roam-skip.xml", self.addon_path, "default", "1080i")
            self.dialog.label = label
            self.dialog.show()
            return None
        answer = self.dialog.answer
        if answer:
            self.dialog = None
        return answer

    def hide_skip(self):
        if self.dialog is not None:
            self.dialog.close()
            self.dialog = None
