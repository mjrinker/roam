"""One playback, watched over from the add-on's own process while Kodi plays: it skips and mutes scenes, offers the skip buttons, tells Roam where the
person is, holds the place when the server limits how many can watch, and notices when playback ends. Written against a small `adapter` (what Kodi can do)
so it can be tested without Kodi."""
from . import timeline
from .api import ApiError

IDLE_TICKS = 8  # about two seconds
SAVE_EVERY = 15
BEAT_EVERY = 30


class PlaybackSession:
    def __init__(self, manifest, owner_kind, owner_id, api, adapter, clock, skip_instead_of_mute=False):
        self.m = manifest
        self.kind = owner_kind
        self.id = owner_id
        self.api = api
        self.a = adapter
        self.clock = clock
        self.skip_instead_of_mute = skip_instead_of_mute
        self.segments = manifest["segments"]
        self.duration = manifest["durationSeconds"]
        self.g = 0.0  # where in the video, in global time
        self.part = 0
        self.auto_done = set()
        self.muted_by_us = False
        self.last_jump = -1000.0
        self.last_save = clock()
        self.last_beat = clock()
        self.dismissed = set()
        self.lost = False
        self.ended = False
        self.started = False
        self.idle = 0

    # ── one look at the player ──
    def tick(self):
        """Call about four times a second while playing. Returns False once playback is over."""
        if not self.a.playing():
            # Between one file and the next, Kodi can look stopped for a moment: only a couple of seconds of it counts as over.
            self.idle += 1
            return True if self.idle < IDLE_TICKS else self._stopped()
        self.idle = 0
        self.started = True
        self.part = min(self.a.playlist_position(), len(self.segments) - 1)
        seg = self.segments[self.part]
        here = self.a.time()
        self.g = timeline.global_time(seg, here)
        end = seg.get("inFileEndSeconds")
        if end is not None and here >= end:
            # A slice of a shared file ends before the file does: move on to the next part, or stop.
            if self.part < len(self.segments) - 1:
                self.a.goto_part(self.part + 1, self.segments[self.part + 1].get("inFileOffsetSeconds", 0))
            else:
                self.a.stop()
            return True
        self._scenes()
        self._skip_button()
        self._housekeeping()
        return True

    def _scenes(self):
        scene = timeline.scene_at(self.m.get("skips"), self.g)
        if scene and scene["action"] == "mute" and not self.skip_instead_of_mute:
            if not self.muted_by_us:
                self.muted_by_us = self.a.set_mute(True)
            return
        if self.muted_by_us:
            self.a.set_mute(False)
            self.muted_by_us = False
        if scene and abs(self.g - self.last_jump) > 1:
            self.last_jump = self.g
            self.seek_global(scene["endSeconds"])

    def _skip_button(self):
        b = timeline.skip_button_at(self.m.get("skipSegments"), self.g)
        if not b or b["kind"] in self.dismissed:
            self.a.hide_skip()
            return
        if (self.m.get("autoSkip") or {}).get(b["kind"]) and b["kind"] not in self.auto_done:
            self.auto_done.add(b["kind"])
            self.a.hide_skip()
            self.seek_global(b["to"])
            return
        answer = self.a.show_skip(b["label"])
        if answer == "pressed":
            self.a.hide_skip()
            self.seek_global(b["to"])
        elif answer == "dismissed":
            self.dismissed.add(b["kind"])

    def seek_global(self, t):
        t = max(0.0, min(t, self.duration - 1))
        loc = timeline.locate_part(self.segments, t)
        if loc is None:
            return
        index, _seg, local = loc
        if index == self.part:
            self.a.seek(local)
        else:
            self.a.goto_part(index, local)

    def _housekeeping(self):
        now = self.clock()
        if now - self.last_save >= SAVE_EVERY:
            self.save(False)
        if self.m.get("heartbeat") and now - self.last_beat >= BEAT_EVERY:
            self.last_beat = now
            try:
                self.api.post("/api/playback/beat", {"ownerKind": self.kind, "ownerId": self.id, "paused": self.a.paused()})
            except ApiError as e:
                if e.status == 423:
                    self.lost = True
                    self.a.notify(e.message or "This isn't available any more.")
                    self.a.stop()

    # ── Roam's record ──
    def save(self, finished):
        self.last_save = self.clock()
        if self.kind == "extra":
            return
        try:
            self.api.patch("/api/watch-state", {"ownerKind": self.kind, "ownerId": self.id, "positionSeconds": int(self.g), "durationSeconds": int(self.duration), "finished": bool(finished)})
        except ApiError:
            pass  # a save lost to a bad moment isn't worth interrupting the film

    def _stopped(self):
        if self.ended:
            return False
        self.ended = True
        if not self.started:
            return False  # it never began: nothing to remember (and the saved place must not be overwritten)
        if self.muted_by_us:
            self.a.set_mute(False)
            self.muted_by_us = False
        self.a.hide_skip()
        self.save(timeline.is_finished(self.g, self.duration))
        if self.m.get("heartbeat"):
            try:
                self.api.post("/api/playback/end", {})
            except ApiError:
                pass
        return False

    @property
    def finished(self):
        return timeline.is_finished(self.g, self.duration)
