"""Every click on the add-on arrives here as a plugin:// address; it answers with a list to show, or plays something."""
import sys
import time
import urllib.parse

import xbmc
import xbmcaddon
import xbmcgui
import xbmcplugin
import xbmcvfs

from . import auth, timeline
from .api import ApiClient, ApiError
from .kodi_adapter import KodiAdapter
from .session import PlaybackSession

ADDON = xbmcaddon.Addon()
ID = ADDON.getAddonInfo("id")


def build_url(**params):
    return "plugin://%s/?%s" % (ID, urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}))


class Context:
    def __init__(self, handle, params):
        self.handle = handle
        self.params = params
        folder = xbmcvfs.translatePath(ADDON.getAddonInfo("profile"))
        self.store = auth.Store(folder)
        self.base = ADDON.getSetting("server_url").strip().rstrip("/")
        self.api = ApiClient(self.base, self.store.get("token"))

    @property
    def server(self):
        return self.store.get("server_id")


# ── Words and pictures ──
def set_video_info(li, title, plot=None, year=None, mediatype="video", playcount=None, episode=None):
    try:  # Kodi 20 and later
        tag = li.getVideoInfoTag()
        tag.setTitle(title)
        tag.setMediaType(mediatype)
        if plot:
            tag.setPlot(plot)
        if year:
            tag.setYear(int(year))
        if playcount is not None:
            tag.setPlaycount(int(playcount))
        if episode:
            tag.setEpisode(int(episode))
    except AttributeError:
        info = {"title": title, "mediatype": mediatype}
        if plot:
            info["plot"] = plot
        if year:
            info["year"] = int(year)
        if playcount is not None:
            info["playcount"] = int(playcount)
        if episode:
            info["episode"] = int(episode)
        li.setInfo("video", info)


def art(li, url, square=False):
    if url:
        li.setArt({"thumb": url, "poster": url, "icon": url} if not square else {"thumb": url, "icon": url})


def add_folder(ctx, label, url, thumb=None, square=False):
    li = xbmcgui.ListItem(label=label)
    art(li, thumb, square)
    xbmcplugin.addDirectoryItem(ctx.handle, url, li, True)


def add_playable(ctx, label, url, thumb=None, square=False, info=None, context=None):
    li = xbmcgui.ListItem(label=label)
    art(li, thumb, square)
    li.setProperty("IsPlayable", "true")
    if info:
        set_video_info(li, label, **info)
    if context:
        li.addContextMenuItems(context)
    xbmcplugin.addDirectoryItem(ctx.handle, url, li, False)


def add_item(ctx, item, queue=None):
    """One of the API's items as a list entry."""
    kind, label, thumb, square = item["type"], item["name"], item.get("posterUrl"), bool(item.get("square"))
    sub = item.get("subtitle")
    if sub and kind in ("movie", "show"):
        label = "%s (%s)" % (label, sub) if str(sub).isdigit() else label
    if kind == "movie":
        add_playable(ctx, label, build_url(action="play", kind="title", id=item["id"], name=item["name"]), thumb, square, {"mediatype": "movie", "year": sub if str(sub or "").isdigit() else None},
                     [("Play from the beginning", "PlayMedia(%s)" % build_url(action="play", kind="title", id=item["id"], name=item["name"], start_over="1")),
                      ("Roam: details", "RunPlugin(%s)" % build_url(action="info", id=item["id"])),
                      ("Roam: chapters", "Container.Update(%s)" % build_url(action="chapters", id=item["id"], name=item["name"])),
                      ("Roam: extras", "Container.Update(%s)" % build_url(action="extras", id=item["id"], name=item["name"]))])
    elif kind == "episode":
        add_playable(ctx, label, build_url(action="play", kind="episode", id=item["id"], name=item["name"], queue=queue), thumb, square, {"mediatype": "episode"})
    elif kind == "show":
        li = xbmcgui.ListItem(label=label)
        art(li, thumb)
        li.addContextMenuItems([("Roam: details", "RunPlugin(%s)" % build_url(action="info", id=item["id"]))])
        xbmcplugin.addDirectoryItem(ctx.handle, build_url(action="show", id=item["id"], name=item["name"]), li, True)
    elif kind == "artist":
        add_folder(ctx, label, build_url(action="artist", id=item["id"]), thumb, True)
    elif kind == "album":
        add_folder(ctx, label, build_url(action="album", id=item["id"]), thumb, True)
    elif kind in ("audiobook", "audio"):
        add_playable(ctx, label, build_url(action="play_audio", id=item["id"], name=item["name"], remember="1" if kind == "audiobook" else "0"), thumb, True)


def end(ctx, content="videos", ok=True):
    xbmcplugin.setContent(ctx.handle, content)
    xbmcplugin.endOfDirectory(ctx.handle, succeeded=ok)


def fail(ctx, e):
    """Says what went wrong in words, and ends the list."""
    if isinstance(e, ApiError) and e.status == 401:
        ctx.store.clear()
        xbmcgui.Dialog().ok("Roam", "You've been signed out. Open the add-on again to sign in.")
    elif isinstance(e, ApiError) and e.status == 0:
        xbmcgui.Dialog().ok("Roam", "Roam can't be reached. Check the network and the server address in the add-on's settings.")
    else:
        xbmcgui.Dialog().ok("Roam", getattr(e, "message", "") or "That didn't work. Try again.")
    end(ctx, ok=False)


# ── Signing in ──
def sign_in(ctx):
    label = xbmc.getInfoLabel("System.FriendlyName") or "Kodi"
    try:
        started = auth.start_code(ctx.base, label)
    except ApiError as e:
        xbmcgui.Dialog().ok("Roam", "Couldn't start signing in: %s" % (e.message or "Roam can't be reached."))
        return False
    progress = xbmcgui.DialogProgress()
    progress.create("Sign in to Roam", "On a phone or computer, go to:\n%s\nand type this code:  %s" % (started["verificationUrl"], started["userCode"]))
    interval = max(2, int(started.get("interval", 3)))
    deadline = time.time() + int(started.get("expiresIn", 600))
    monitor = xbmc.Monitor()
    result = None
    while time.time() < deadline and not progress.iscanceled() and not monitor.abortRequested():
        if monitor.waitForAbort(interval):
            break
        answer = auth.poll_code(ctx.base, started["deviceCode"])
        if answer.get("status") == "approved":
            result = answer
            break
        if answer.get("status") == "expired":
            break
    progress.close()
    if not result:
        return False
    ctx.store.set(token=result["accessToken"], server_id=None)
    ctx.api = ApiClient(ctx.base, result["accessToken"])
    return True


def choose_profile(ctx, force=False):
    me = ctx.api.get("/api/v1/me")
    if me.get("profile") and not force:
        return True
    profiles = me.get("profiles", [])
    if not profiles:
        return False
    names = [p["name"] + (" (PIN)" if p.get("hasPin") else "") for p in profiles]
    index = xbmcgui.Dialog().select("Who's watching?", names)
    if index < 0:
        return False
    chosen = profiles[index]
    body = {"viewerId": chosen["id"]}
    if chosen.get("hasPin"):
        pin = xbmcgui.Dialog().input("PIN for %s" % chosen["name"], type=xbmcgui.INPUT_NUMERIC, option=xbmcgui.ALPHANUM_HIDE_INPUT)
        if not pin:
            return False
        body["pin"] = pin
    try:
        ctx.api.post("/api/v1/me/profile", body)
    except ApiError as e:
        xbmcgui.Dialog().ok("Roam", "That PIN isn't right." if e.code == "incorrect_pin" else (e.message or "Couldn't choose that profile."))
        return False
    return True


def choose_server(ctx, force=False):
    servers = ctx.api.get("/api/v1/servers").get("servers", [])
    if not servers:
        xbmcgui.Dialog().ok("Roam", "You're not in any servers yet. Join or create one in Roam on a phone or computer.")
        return False
    saved = ctx.store.get("server_id")
    if not force and any(s["id"] == saved for s in servers):
        return True
    if len(servers) == 1:
        ctx.store.set(server_id=servers[0]["id"])
        return True
    index = xbmcgui.Dialog().select("Choose a server", [s["name"] for s in servers])
    if index < 0:
        return False
    ctx.store.set(server_id=servers[index]["id"])
    return True


def ready(ctx):
    """Signed in, with a profile and a server chosen; asks for whatever is missing. False when the person gave up (the list is then ended)."""
    try:
        if not ctx.store.get("token") and not sign_in(ctx):
            end(ctx, ok=False)
            return False
        if not choose_profile(ctx) or not choose_server(ctx):
            end(ctx, ok=False)
            return False
    except ApiError as e:
        fail(ctx, e)
        return False
    return True


def sp(ctx, path):
    return "/api/v1/servers/%s%s" % (ctx.server, path)


# ── Lists ──
def root(ctx):
    if not ready(ctx):
        return
    add_folder(ctx, "Continue watching", build_url(action="home", section="continueWatching"))
    add_folder(ctx, "Recently added", build_url(action="home", section="recentlyAdded"))
    try:
        libs = ctx.api.get(sp(ctx, "/libraries")).get("libraries", [])
    except ApiError as e:
        return fail(ctx, e)
    for lib in libs:
        if lib.get("style"):
            add_folder(ctx, lib["name"], build_url(action="library", id=lib["id"], style=lib["style"], name=lib["name"]))
    add_folder(ctx, "Search", build_url(action="search"))
    add_folder(ctx, "Switch profile", build_url(action="switch_profile"))
    add_folder(ctx, "Sign out", build_url(action="sign_out"))
    end(ctx)


def home_section(ctx, section):
    if not ready(ctx):
        return
    try:
        home = ctx.api.get(sp(ctx, "/home"))
    except ApiError as e:
        return fail(ctx, e)
    for item in home.get(section, []):
        add_item(ctx, item)
    end(ctx, "movies")


def library(ctx, lib_id, style, name):
    if not ready(ctx):
        return
    q = {}
    if style == "grid":
        q["page"] = ctx.params.get("page", "1")
    else:
        q["path"] = ctx.params.get("path", "")
        q["after"] = ctx.params.get("after")
    try:
        r = ctx.api.get(sp(ctx, "/libraries/%s/items" % lib_id), **q)
    except ApiError as e:
        return fail(ctx, e)
    path = r.get("path", "")
    for folder in r.get("folders", []):
        add_folder(ctx, folder, build_url(action="library", id=lib_id, style=style, name=name, path=(path + "/" + folder) if path else folder))
    for item in r.get("items", []):
        add_item(ctx, item)
    if style == "grid" and r.get("hasMore"):
        add_folder(ctx, "Next page", build_url(action="library", id=lib_id, style=style, name=name, page=int(r.get("page", 1)) + 1))
    elif style != "grid" and r.get("next"):
        add_folder(ctx, "Next page", build_url(action="library", id=lib_id, style=style, name=name, path=path or None, after=r["next"]))
    end(ctx, "albums" if style == "artists" else "movies")


def show(ctx, show_id, name):
    """A show: its seasons (or straight to the episodes when there is one)."""
    if not ready(ctx):
        return
    try:
        d = ctx.api.get(sp(ctx, "/titles/%s" % show_id), **({"season": ctx.params["season"]} if ctx.params.get("season") else {}))
    except ApiError as e:
        return fail(ctx, e)
    if d.get("type") != "show":
        return end(ctx, ok=False)
    if not ctx.params.get("season") and len(d.get("seasons", [])) > 1:
        for n in d["seasons"]:
            add_folder(ctx, "Season %s" % n, build_url(action="show", id=show_id, name=name, season=n), d.get("posterUrl"))
        return end(ctx, "seasons")
    ids = [e["id"] for e in d.get("episodes", [])]
    for i, e in enumerate(d.get("episodes", [])):
        label = "%s. %s" % (e["number"], e.get("name") or "Episode %s" % e["number"])
        rest = ",".join(ids[i + 1:]) or None  # the ones after it, so the next one can start by itself
        add_playable(ctx, label, build_url(action="play", kind="episode", id=e["id"], name=name, queue=rest), d.get("posterUrl"), False,
                     {"mediatype": "episode", "playcount": 1 if e.get("watched") else 0, "episode": e["number"]})
    end(ctx, "episodes")


def clock(seconds):
    s = int(seconds or 0)
    return "%d:%02d:%02d" % (s // 3600, s % 3600 // 60, s % 60) if s >= 3600 else "%d:%02d" % (s // 60, s % 60)


def chapters(ctx, title_id, name):
    """A movie's chapters, each of which plays from where it starts."""
    if not ready(ctx):
        return
    try:
        d = ctx.api.get(sp(ctx, "/titles/%s" % title_id))
    except ApiError as e:
        return fail(ctx, e)
    if not d.get("chapters"):
        xbmcgui.Dialog().ok("Roam", "This has no chapters.")
        return end(ctx, ok=False)
    for c in d["chapters"]:
        add_playable(ctx, "%s  %s" % (clock(c.get("startSeconds")), c.get("title") or "Chapter"), build_url(action="play", kind="title", id=title_id, name=name, start_at=c.get("startSeconds", 0)), d.get("posterUrl"))
    end(ctx, "movies")


def extras(ctx, title_id, name):
    """Trailers, featurettes and the rest, by kind."""
    if not ready(ctx):
        return
    try:
        d = ctx.api.get(sp(ctx, "/titles/%s" % title_id))
    except ApiError as e:
        return fail(ctx, e)
    groups = [g for g in d.get("extras", []) if g.get("items")]
    if not groups:
        xbmcgui.Dialog().ok("Roam", "This has no extras.")
        return end(ctx, ok=False)
    for g in groups:
        for x in g["items"]:
            label = "%s: %s (%s)" % (str(g.get("category", "")).replace("_", " ").capitalize(), x.get("name"), clock(x.get("durationSeconds")))
            add_playable(ctx, label, build_url(action="play", kind="extra", id=x["id"], name=x.get("name", "")), None)
    end(ctx, "movies")


CATEGORY_WORDS = {"violence": "Violence", "language": "Language", "sex": "Sex", "nudity": "Nudity", "fear": "Frightening scenes", "drugs": "Drugs and alcohol",
                  "discrimination": "Discrimination", "commercial": "Commercial content", "dispensable": "Dispensable scenes", "animals": "Animal harm", "distress": "Distressing themes"}


def describe(d):
    """Everything the title page has, as words for a text window."""
    head = " · ".join(str(x) for x in (d.get("year"), d.get("certification"), clock(d["runtimeSeconds"]) if d.get("runtimeSeconds") else None) if x)
    lines = [d.get("name", ""), head]
    if d.get("genres"):
        lines.append(", ".join(d["genres"]))
    ratings = [t for t in ("IMDb %s" % d["imdbRating"] if d.get("imdbRating") else None, "Rotten Tomatoes %s%%" % d["rottenTomatoesScore"] if d.get("rottenTomatoesScore") is not None else None) if t]
    if ratings:
        lines.append("  ".join(ratings))
    if d.get("overview"):
        lines += ["", d["overview"]]
    if d.get("cast"):
        lines += ["", "Cast"] + ["  %s%s" % (c["name"], " as %s" % c["character"] if c.get("character") else "") for c in d["cast"][:20]]
    guide = d.get("guide") or {}
    if guide.get("lines"):
        lines += ["", "Parental guide"]
        for g in guide["lines"]:
            word = CATEGORY_WORDS.get(g.get("category"), str(g.get("category", "")).capitalize())
            detail = ", ".join(x for x in (g.get("severity"), "%s scene%s" % (g["scenes"], "" if g["scenes"] == 1 else "s") if g.get("scenes") else None) if x)
            lines.append("  %s%s%s" % (word, " (%s)" % detail if detail else "", "  - skipped for you" if g.get("skippedForYou") else ""))
    if guide.get("reports"):
        lines += ["", "Community reports"] + ["  %s: %s yes, %s no" % (r["topic"], r.get("yes", 0), r.get("no", 0)) for r in guide["reports"]]
    if guide.get("fromCommunity"):
        lines += ["", "Powered by DoesTheDogDie.com. Reports are from the community and unverified."]
    return "\n".join(lines)


def info(ctx, title_id):
    """The title's page in words: what it is about, who is in it, what its parental guide says."""
    if not ready(ctx):
        return
    try:
        d = ctx.api.get(sp(ctx, "/titles/%s" % title_id))
    except ApiError as e:
        return fail(ctx, e)
    if d.get("type") == "show":
        d = dict(d, runtimeSeconds=None)
    xbmcgui.Dialog().textviewer(d.get("name", "Roam"), describe(d))


def artist(ctx, artist_id):
    if not ready(ctx):
        return
    try:
        d = ctx.api.get(sp(ctx, "/artists/%s" % artist_id))
    except ApiError as e:
        return fail(ctx, e)
    for al in d.get("albums", []):
        add_folder(ctx, al["name"] + (" (%s)" % al["subtitle"] if al.get("subtitle") else ""), build_url(action="album", id=al["id"]), al.get("posterUrl"), True)
    end(ctx, "albums")


def album(ctx, album_id):
    if not ready(ctx):
        return
    try:
        d = ctx.api.get(sp(ctx, "/albums/%s" % album_id))
    except ApiError as e:
        return fail(ctx, e)
    for t in d.get("tracks", []):
        label = ("%s. " % t["number"] if t.get("number") else "") + t["name"]
        add_playable(ctx, label, build_url(action="play_audio", id=t["id"], name=t["name"], remember="0"), d.get("coverUrl"), True)
    end(ctx, "songs")


def search(ctx):
    if not ready(ctx):
        return
    q = ctx.params.get("q") or xbmcgui.Dialog().input("Search Roam")
    if not q:
        return end(ctx, ok=False)
    try:
        r = ctx.api.get(sp(ctx, "/search"), q=q)
    except ApiError as e:
        return fail(ctx, e)
    for item in r.get("items", []):
        add_item(ctx, item)
    end(ctx, "movies")


# ── Playing ──
def play(ctx):
    """Plays a movie or episode: every file of it is queued, and this process stays to look after the playback until it ends."""
    p = ctx.params
    kind, item_id = p["kind"], p["id"]
    try:
        manifest = ctx.api.get("/api/play/%s/%s" % (kind, item_id))
    except ApiError as e:
        xbmcplugin.setResolvedUrl(ctx.handle, False, xbmcgui.ListItem())
        if e.status == 423:
            return xbmcgui.Dialog().ok("Roam", e.message or "This isn't available right now.")
        return fail(ctx, e)
    segments = manifest["segments"]
    start = 0.0
    if p.get("start_at"):  # a chapter
        try:
            start = max(0.0, float(p["start_at"]))
        except ValueError:
            start = 0.0
    elif p.get("start_over") != "1" and 0 < manifest.get("resumeSeconds", 0) < manifest["durationSeconds"] - 30:
        start = manifest["resumeSeconds"]
    index, _seg, local = timeline.locate_part(segments, start)
    playlist = xbmc.PlayList(xbmc.PLAYLIST_VIDEO)
    playlist.clear()
    for i, seg in enumerate(segments):
        li = xbmcgui.ListItem(label=p.get("name", ""), path=seg["url"])
        set_video_info(li, p.get("name", ""), mediatype="episode" if kind == "episode" else "movie")
        if i == index and local > 1:
            li.setProperty("StartOffset", str(int(local)))
        playlist.add(seg["url"], li)
    xbmcplugin.setResolvedUrl(ctx.handle, False, xbmcgui.ListItem())  # this process starts the playback itself
    player = xbmc.Player()
    player.play(playlist, startpos=index)
    if manifest.get("notice"):
        xbmcgui.Dialog().notification("Roam", manifest["notice"], xbmcgui.NOTIFICATION_INFO, 7000)
    session = PlaybackSession(manifest, kind, item_id, ctx.api, KodiAdapter(player, playlist, ADDON.getAddonInfo("path")), time.time,
                              ADDON.getSettingBool("mute_as_skip"))
    watch(session)
    # On to the next episode of the season, if the person watched this one to the end.
    queue = [i for i in (p.get("queue") or "").split(",") if i]
    if queue and session.finished and not xbmc.Monitor().abortRequested():
        xbmc.executebuiltin("PlayMedia(%s)" % build_url(action="play", kind="episode", id=queue[0], name=p.get("name", ""), queue=",".join(queue[1:]) or None))


def watch(session):
    """Looks after one playback: waits for it to start, then checks it four times a second until it ends."""
    monitor = xbmc.Monitor()
    for _ in range(150):  # up to fifteen seconds for it to start
        if monitor.waitForAbort(0.1) or session.a.playing():
            break
    while not monitor.abortRequested():
        if not session.tick():
            return
        if monitor.waitForAbort(0.25):
            break
    session.tick()


def play_audio(ctx):
    """A song, or an audiobook (its parts queued, and its place kept)."""
    item_id = ctx.params["id"]
    remember = ctx.params.get("remember") == "1"
    try:
        m = ctx.api.get("/api/audiobooks/%s/manifest" % item_id)
        urls = {u["index"]: u["url"] for u in m.get("urls", [])}
        for seg in m["segments"]:
            if seg["index"] not in urls:
                urls[seg["index"]] = ctx.api.get("/api/audiobooks/%s/segments/%s" % (item_id, seg["index"]))["url"]
    except ApiError as e:
        xbmcplugin.setResolvedUrl(ctx.handle, False, xbmcgui.ListItem())
        if e.status == 423:
            return xbmcgui.Dialog().ok("Roam", e.message or "This isn't available right now.")
        return fail(ctx, e)
    segments = m["segments"]
    if len(segments) == 1 and not remember:
        li = xbmcgui.ListItem(label=ctx.params.get("name", ""), path=urls[segments[0]["index"]])
        return xbmcplugin.setResolvedUrl(ctx.handle, True, li)
    start = m.get("resumeSeconds", 0) if remember else 0
    if not 0 < start < m["durationSeconds"] - 30:
        start = 0
    index, _seg, local = timeline.locate_part([{"startSeconds": s["startSeconds"], "durationSeconds": s["durationSeconds"]} for s in segments], start)
    playlist = xbmc.PlayList(xbmc.PLAYLIST_MUSIC)
    playlist.clear()
    for i, seg in enumerate(segments):
        li = xbmcgui.ListItem(label=ctx.params.get("name", ""), path=urls[seg["index"]])
        if i == index and local > 1:
            li.setProperty("StartOffset", str(int(local)))
        playlist.add(urls[seg["index"]], li)
    xbmcplugin.setResolvedUrl(ctx.handle, False, xbmcgui.ListItem())
    player = xbmc.Player()
    player.play(playlist, startpos=index)
    if remember:
        manifest = {"segments": [{"startSeconds": s["startSeconds"], "durationSeconds": s["durationSeconds"]} for s in segments], "durationSeconds": m["durationSeconds"], "heartbeat": m.get("heartbeat")}
        watch(PlaybackSession(manifest, "title", item_id, ctx.api, KodiAdapter(player, playlist, ADDON.getAddonInfo("path")), time.time))


# ── Account ──
def switch_profile(ctx):
    try:
        if choose_profile(ctx, force=True):
            xbmc.executebuiltin("Container.Update(%s,replace)" % build_url(action="root"))
    except ApiError as e:
        fail(ctx, e)
    xbmcplugin.endOfDirectory(ctx.handle, succeeded=False)


def sign_out(ctx):
    if xbmcgui.Dialog().yesno("Roam", "Sign out of Roam on this device?"):
        try:
            ctx.api.delete("/api/v1/session")
        except ApiError:
            pass
        ctx.store.clear()
    xbmcplugin.endOfDirectory(ctx.handle, succeeded=False)


def run(argv):
    handle = int(argv[1])
    params = dict(urllib.parse.parse_qsl(argv[2][1:] if len(argv) > 2 else ""))
    ctx = Context(handle, params)
    action = params.get("action", "root")
    if action == "root":
        root(ctx)
    elif action == "home":
        home_section(ctx, params["section"])
    elif action == "library":
        library(ctx, params["id"], params["style"], params.get("name", ""))
    elif action == "show":
        show(ctx, params["id"], params.get("name", ""))
    elif action == "info":
        info(ctx, params["id"])
    elif action == "chapters":
        chapters(ctx, params["id"], params.get("name", ""))
    elif action == "extras":
        extras(ctx, params["id"], params.get("name", ""))
    elif action == "artist":
        artist(ctx, params["id"])
    elif action == "album":
        album(ctx, params["id"])
    elif action == "search":
        search(ctx)
    elif action == "play":
        play(ctx)
    elif action == "play_audio":
        play_audio(ctx)
    elif action == "sign_in":
        sign_in(ctx)
    elif action == "switch_profile":
        switch_profile(ctx)
    elif action == "sign_out":
        sign_out(ctx)
    else:
        xbmcplugin.endOfDirectory(handle, succeeded=False)


if __name__ == "__main__":
    run(sys.argv)
