"""Where things are in a video stored as one or more files played end to end (the same maths as the web, TV and Roku players)."""


def locate_part(segments, t):
    """The part holding global time t: (index, segment, local_time) with local_time in the part's own file."""
    last = len(segments) - 1
    for i, seg in enumerate(segments):
        if t < seg["startSeconds"] + seg["durationSeconds"] or i == last:
            within = min(max(t - seg["startSeconds"], 0), seg["durationSeconds"])
            return i, seg, seg.get("inFileOffsetSeconds", 0) + within
    return None


def global_time(seg, file_position):
    """Global time for a position (seconds into the file that is playing)."""
    return seg["startSeconds"] + (file_position - seg.get("inFileOffsetSeconds", 0))


def scene_at(skips, t):
    """The scene to skip or mute that holds global time t, or None."""
    for s in skips or []:
        if s["startSeconds"] - 0.02 <= t < s["endSeconds"] - 0.02:
            return s
    return None


_LABELS = {"intro": "Skip intro", "recap": "Skip recap", "outro": "Skip credits", "preview": "Skip preview"}


def skip_button_at(segments, t):
    """The intro/recap/credits/preview button to offer at global time t, or None: {label, to, kind}."""
    for s in segments or []:
        if s["startSeconds"] - 0.5 <= t < s["endSeconds"] - 1:
            return {"label": _LABELS.get(s["kind"], "Skip"), "to": s["endSeconds"], "kind": s["kind"]}
    return None


def is_finished(position, duration):
    """Whether a stopped video counts as watched: within the last 90 seconds, or 95% through."""
    return duration > 0 and (duration - position < 90 or position >= duration * 0.95)
