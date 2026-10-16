/** Gapless playback and crossfade inside the player engine: the next song is got ready on a second element and takes over without a fetch. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayer, type AudioPlayerState } from "./audio-player-provider";

type Manifest = Record<string, unknown>;
const manifestFor = (id: string, over: Manifest = {}): Manifest => ({
  titleId: id, name: `Song ${id}`, authors: [], narrators: [], seriesName: null, seriesPosition: null, coverUrl: null, albumId: "album",
  durationSeconds: 100, segments: [{ index: 0, startSeconds: 0, durationSeconds: 100 }], chapters: [], resumeSeconds: 0,
  urls: [{ index: 0, url: `https://box.example/${id}.mp3`, expiresAt: new Date(Date.now() + 3600_000).toISOString() }], ...over,
});

/** A stand-in <audio>: records what is loaded and played. `fixedVolume` behaves like an iPhone, which ignores volume changes. */
function fakeAudio(fixedVolume = false) {
  let volume = 1;
  const el = {
    src: "", currentTime: 0, playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: true, paused: true, ended: false, muted: false, preload: "",
    get volume() { return volume; },
    set volume(v: number) { if (!fixedVolume) volume = v; },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    pause: vi.fn(function (this: { paused: boolean }) { this.paused = true; }),
    play: vi.fn(async function (this: { paused: boolean }) { this.paused = false; }),
    load: vi.fn(),
    removeAttribute: vi.fn(function (this: { src: string }, name: string) { if (name === "src") this.src = ""; }),
  };
  return el;
}

let state: AudioPlayerState;
const requested: string[] = [];
const failing = new Set<string>();
const manifestOver = new Map<string, Manifest>();

function newPlayer(opts: { fixedVolume?: boolean; standby?: boolean } = {}) {
  state = { book: null, status: "idle", error: null, buffering: false, position: 0, rate: 1, sleep: null, sleepMinutesLeft: null, chapterIndex: -1, listPosition: null, crossfade: 0 };
  const { actions, internals } = createPlayer((u) => (state = typeof u === "function" ? u(state) : u), 1);
  const main = fakeAudio(opts.fixedVolume);
  const standby = fakeAudio(opts.fixedVolume);
  internals.attach(main as never);
  if (opts.standby !== false) internals.attachStandby(standby as never);
  return { actions, internals, main, standby };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  requested.length = 0;
  failing.clear();
  manifestOver.clear();
  vi.stubGlobal("fetch", async (url: string) => {
    const m = /audiobooks\/([^/]+)\/manifest/.exec(url);
    if (!m) return new Response("{}", { status: 200 });
    requested.push(m[1]);
    return failing.has(m[1]) ? new Response(JSON.stringify({ error: "Not found" }), { status: 404 }) : new Response(JSON.stringify(manifestFor(m[1], manifestOver.get(m[1]))), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getting the next song ready", () => {
  it("fetches the next song of the list once and loads it on the standby element", async () => {
    const p = newPlayer();
    await p.actions.playList(["a", "b", "c"], 0);
    await settle();
    await p.internals.prepareNext();
    await p.internals.prepareNext();
    expect(requested).toEqual(["a", "b"]);
    expect(p.standby.src).toBe("https://box.example/b.mp3");
    expect(p.main.src).toBe("https://box.example/a.mp3");
  });

  it("does nothing on the last song, without a list, or without a standby element", async () => {
    const p = newPlayer();
    await p.actions.playList(["a", "b"], 1);
    await p.internals.prepareNext();
    expect(requested).toEqual(["b"]);
    const solo = newPlayer();
    requested.length = 0;
    await solo.actions.load("a", { autoplay: true });
    await solo.internals.prepareNext();
    expect(requested).toEqual(["a"]);
    const bare = newPlayer({ standby: false });
    requested.length = 0;
    await bare.actions.playList(["a", "b"], 0);
    await bare.internals.prepareNext();
    expect(requested).toEqual(["a"]);
    expect(bare.internals.handover(0)).toBe(false);
  });

  it("does not try a song again and again when it can't be fetched, and leaves it to the normal path", async () => {
    const p = newPlayer();
    failing.add("b");
    await p.actions.playList(["a", "b", "c"], 0);
    await p.internals.prepareNext();
    await p.internals.prepareNext();
    await p.internals.prepareNext();
    expect(requested.filter((id) => id === "b")).toHaveLength(1);
    p.actions.next();
    await settle();
    await settle();
    expect(state.book?.titleId).toBe("c"); // b is skipped by the usual rules
  });

  it("leaves a song that holds a place on a server limiting playback to the normal path", async () => {
    const p = newPlayer();
    manifestOver.set("b", { heartbeat: true });
    await p.actions.playList(["a", "b"], 0);
    await p.internals.prepareNext();
    expect(p.internals.e.next).toBeNull();
    expect(p.internals.handover(0)).toBe(false);
  });

  it("drops a prepared song that is no longer the next one", async () => {
    const p = newPlayer();
    await p.actions.playList(["a", "b", "c"], 0);
    await p.internals.prepareNext();
    p.internals.e.list!.ids = ["a", "c", "b"]; // the list changed under it
    expect(p.internals.handover(0)).toBe(false);
    expect(p.internals.e.next).toBeNull();
    expect(state.book?.titleId).toBe("a");
  });
});

describe("the next song taking over", () => {
  it("starts at once on the other element, with no fetch, and moves the list on", async () => {
    const p = newPlayer();
    await p.actions.playList(["a", "b", "c"], 0);
    await settle();
    await p.internals.prepareNext();
    requested.length = 0;
    expect(p.internals.handover(0)).toBe(true);
    expect(requested).toEqual([]);
    expect(state.book?.titleId).toBe("b");
    expect(state.status).toBe("playing");
    expect(state.listPosition).toEqual({ index: 1, length: 3 });
    expect(p.internals.audio()).toBe(p.standby);
    expect(p.standby.play).toHaveBeenCalled();
    expect(p.standby.currentTime).toBe(0);
    expect(p.main.pause).toHaveBeenCalled();
    expect(p.main.src).toBe(""); // the old element is free for the song after
  });

  it("keeps going: the next song after that is prepared on the element just freed", async () => {
    const p = newPlayer();
    await p.actions.playList(["a", "b", "c"], 0);
    await settle();
    await p.internals.prepareNext();
    p.internals.handover(0);
    await p.internals.prepareNext();
    expect(p.main.src).toBe("https://box.example/c.mp3");
    expect(p.internals.handover(0)).toBe(true);
    expect(state.book?.titleId).toBe("c");
    expect(p.internals.audio()).toBe(p.main);
    await p.internals.prepareNext();
    expect(p.internals.handover(0)).toBe(false); // the end of the list
  });

  it("is what Next does when the next song is already waiting, and the usual load when it is not", async () => {
    const p = newPlayer();
    await p.actions.playList(["a", "b", "c"], 0);
    await settle();
    await p.internals.prepareNext();
    requested.length = 0;
    p.actions.next();
    expect(requested).toEqual([]);
    expect(state.book?.titleId).toBe("b");
    p.actions.next(); // c was never prepared
    await settle();
    expect(requested).toEqual(["c"]);
    expect(state.book?.titleId).toBe("c");
  });

  it("is dropped by closing the player, and by starting something else", async () => {
    const p = newPlayer();
    await p.actions.playList(["a", "b"], 0);
    await p.internals.prepareNext();
    await p.actions.load("z", { autoplay: true });
    expect(p.internals.e.next).toBeNull();
    expect(state.listPosition).toBeNull();
    const q = newPlayer();
    await q.actions.playList(["a", "b"], 0);
    await q.internals.prepareNext();
    q.actions.close();
    expect(q.internals.e.next).toBeNull();
    expect(q.standby.src).toBe("");
  });
});

describe("crossfade", () => {
  it("is remembered and limited to 0 to 12 seconds", () => {
    const p = newPlayer();
    p.actions.setCrossfade(6);
    expect(state.crossfade).toBe(6);
    expect(p.internals.e.crossfade).toBe(6);
    p.actions.setCrossfade(99);
    expect(state.crossfade).toBe(12);
    p.actions.setCrossfade(-4);
    expect(state.crossfade).toBe(0);
  });

  it("fades the old song out and the new one in over the overlap, then lets the old one go", async () => {
    vi.useFakeTimers();
    const p = newPlayer();
    await p.actions.playList(["a", "b"], 0);
    await vi.advanceTimersByTimeAsync(5);
    await p.internals.prepareNext();
    p.main.pause.mockClear();
    expect(p.internals.handover(4)).toBe(true);
    expect(p.standby.volume).toBe(0); // the new song starts silent
    expect(p.main.volume).toBe(1);
    expect(p.main.pause).not.toHaveBeenCalled(); // the old one keeps playing while it fades
    await vi.advanceTimersByTimeAsync(2000);
    expect(p.standby.volume).toBeGreaterThan(0.6); // halfway: both about 0.7
    expect(p.standby.volume).toBeLessThan(0.8);
    expect(p.main.volume).toBeGreaterThan(0.6);
    expect(p.main.volume).toBeLessThan(0.8);
    await vi.advanceTimersByTimeAsync(2100);
    expect(p.main.pause).toHaveBeenCalled();
    expect(p.main.volume).toBe(1); // ready for the next use
    expect(p.standby.volume).toBe(1);
    expect(p.internals.e.fade).toBeNull();
    expect(state.book?.titleId).toBe("b");
  });

  it("pausing, seeking or starting another song in the middle of a fade stops the old one at once", async () => {
    vi.useFakeTimers();
    for (const interrupt of ["pause", "seek", "load"] as const) {
      const p = newPlayer();
      await p.actions.playList(["a", "b", "c"], 0);
      await vi.advanceTimersByTimeAsync(5);
      await p.internals.prepareNext();
      p.main.pause.mockClear();
      p.internals.handover(6);
      expect(p.internals.e.fade).not.toBeNull();
      if (interrupt === "pause") p.actions.pause();
      else if (interrupt === "seek") p.actions.seek(10);
      else void p.actions.load("c", { autoplay: true });
      expect(p.internals.e.fade).toBeNull();
      expect(p.main.pause).toHaveBeenCalled();
    }
  });

  it("on a device that ignores volume (an iPhone), plays gaplessly without the overlap", async () => {
    const p = newPlayer({ fixedVolume: true });
    await p.actions.playList(["a", "b"], 0);
    await settle();
    await p.internals.prepareNext();
    expect(p.internals.handover(6)).toBe(true);
    expect(p.internals.e.fade).toBeNull();
    expect(p.main.pause).toHaveBeenCalled();
    expect(state.book?.titleId).toBe("b");
  });
});
