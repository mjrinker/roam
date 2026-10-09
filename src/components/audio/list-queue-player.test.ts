/** The song-list queue inside the player engine: switching quickly, failures, and the ends of the list. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayer, type AudioPlayerState } from "./audio-player-provider";

type Manifest = Record<string, unknown>;
const manifestFor = (id: string): Manifest => ({
  titleId: id, name: `Song ${id}`, authors: [], narrators: [], seriesName: null, seriesPosition: null, coverUrl: null, albumId: "album",
  durationSeconds: 100, segments: [{ index: 0, startSeconds: 0, durationSeconds: 100 }], chapters: [], resumeSeconds: 0,
  urls: [{ index: 0, url: `https://box.example/${id}.mp3`, expiresAt: new Date(Date.now() + 3600_000).toISOString() }],
});

/** A stand-in <audio>: records what is loaded and never plays. */
function fakeAudio() {
  const el = { src: "", currentTime: 0, playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: true, paused: true, ended: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), pause: vi.fn(), play: vi.fn(async () => undefined), load: vi.fn(), removeAttribute: vi.fn() };
  return el;
}

let state: AudioPlayerState;
const gates = new Map<string, { release: () => void; promise: Promise<void> }>();
const failing = new Set<string>();
const requested: string[] = [];

function gate(id: string) {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  gates.set(id, { release, promise });
}

function newPlayer() {
  state = { book: null, status: "idle", error: null, buffering: false, position: 0, rate: 1, sleep: null, sleepMinutesLeft: null, chapterIndex: -1, listPosition: null };
  const { actions, internals } = createPlayer((u) => (state = typeof u === "function" ? u(state) : u), 1);
  internals.attach(fakeAudio() as never);
  return { actions, internals };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  gates.clear();
  failing.clear();
  requested.length = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    const m = /audiobooks\/([^/]+)\/manifest/.exec(url);
    if (!m) return new Response("{}", { status: 200 });
    const id = m[1];
    requested.push(id);
    await gates.get(id)?.promise;
    return failing.has(id) ? new Response(JSON.stringify({ error: "Not found" }), { status: 404 }) : new Response(JSON.stringify(manifestFor(id)), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("playing a list of songs", () => {
  it("starts at the chosen song and reports where it is in the list", async () => {
    const p = newPlayer();
    await p.actions.playList(["a", "b", "c"], 1);
    expect(state.book?.titleId).toBe("b");
    expect(state.listPosition).toEqual({ index: 1, length: 3 });
  });

  it("next and previous move through the list, stop at the ends, and previous restarts a song heard for a while", async () => {
    const p = newPlayer();
    await p.actions.playList(["a", "b"], 0);
    p.actions.next();
    await settle();
    expect(state.book?.titleId).toBe("b");
    p.actions.next(); // already last
    await settle();
    expect(state.book?.titleId).toBe("b");
    expect(state.listPosition).toEqual({ index: 1, length: 2 });
    p.internals.e.position = 30;
    p.actions.previous(); // late in the song: restarts it
    await settle();
    expect(state.book?.titleId).toBe("b");
    p.internals.e.position = 1;
    p.actions.previous();
    await settle();
    expect(state.book?.titleId).toBe("a");
    expect(state.listPosition?.index).toBe(0);
  });

  it("a slow song that was clicked away from does not take over when it finally arrives", async () => {
    const p = newPlayer();
    gate("b");
    const first = p.actions.playList(["a", "b", "c"], 0);
    await first;
    p.actions.next(); // b: held up at the network
    await settle();
    p.actions.next(); // c: arrives at once
    await settle();
    expect(state.book?.titleId).toBe("c");
    gates.get("b")!.release();
    await settle();
    expect(state.book?.titleId).toBe("c"); // b did not replace c
    expect(state.listPosition).toEqual({ index: 2, length: 3 });
  });

  it("skips a song that can't be loaded and carries on with the next", async () => {
    const p = newPlayer();
    failing.add("b");
    await p.actions.playList(["a", "b", "c"], 0);
    p.actions.next();
    await settle();
    await settle();
    expect(requested).toEqual(["a", "b", "c"]);
    expect(state.book?.titleId).toBe("c");
    expect(state.listPosition).toEqual({ index: 2, length: 3 });
  });

  it("when the last song can't load, the list goes back to pointing at the song that is really loaded", async () => {
    const p = newPlayer();
    failing.add("b");
    await p.actions.playList(["a", "b"], 0);
    p.actions.next();
    await settle();
    await settle();
    expect(state.book?.titleId).toBe("a");
    expect(state.listPosition).toEqual({ index: 0, length: 2 });
  });

  it("is dropped when something outside the list starts, and when the player closes", async () => {
    const p = newPlayer();
    await p.actions.playList(["a", "b"], 0);
    await p.actions.load("zzz", { autoplay: true });
    expect(state.listPosition).toBeNull();
    await p.actions.playList(["a", "b"], 0);
    p.actions.close();
    expect(state.listPosition).toBeNull();
    expect(p.internals.e.list).toBeNull();
  });

  it("is dropped when a playlist queue is started for a song in it", async () => {
    const p = newPlayer();
    await p.actions.playList(["a", "b"], 0);
    await p.actions.load("a", { autoplay: true, queue: { playlistId: "pl", itemId: "it" } });
    expect(state.listPosition).toBeNull();
    expect(p.internals.e.queue).toMatchObject({ playlistId: "pl", titleId: "a" });
  });

  it("refuses an empty list", async () => {
    const p = newPlayer();
    expect((await p.actions.playList([], 0)).ok).toBe(false);
    expect(state.book).toBeNull();
  });
});
