/** Audio playback speed: starts at the library's default, lasts until the player is closed, and is never saved. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayer, type AudioPlayerState } from "./audio-player-provider";

const manifestFor = (id: string, defaultRate: number | null) => ({
  titleId: id, name: `Book ${id}`, authors: [], narrators: [], seriesName: null, seriesPosition: null, coverUrl: null, albumId: null,
  durationSeconds: 100, segments: [{ index: 0, startSeconds: 0, durationSeconds: 100 }], chapters: [], resumeSeconds: 0, defaultRate,
  urls: [{ index: 0, url: `https://box.example/${id}.mp3`, expiresAt: new Date(Date.now() + 3600_000).toISOString() }],
});
const defaults = new Map<string, number | null>();
const calls: string[] = [];
let state: AudioPlayerState;
const audioEl = () => ({ src: "", currentTime: 0, playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: true, paused: true, ended: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), pause: vi.fn(), play: vi.fn(async () => undefined), load: vi.fn(), removeAttribute: vi.fn() });

function newPlayer() {
  state = { book: null, status: "idle", error: null, buffering: false, position: 0, rate: 1, sleep: null, sleepMinutesLeft: null, chapterIndex: -1, listPosition: null };
  const { actions, internals } = createPlayer((u) => (state = typeof u === "function" ? u(state) : u));
  const el = audioEl();
  internals.attach(el as never);
  return { actions, el };
}

beforeEach(() => {
  defaults.clear();
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    const m = /audiobooks\/([^/]+)\/manifest/.exec(url);
    return m ? new Response(JSON.stringify(manifestFor(m[1], defaults.get(m[1]) ?? null)), { status: 200 }) : new Response("{}", { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("audio playback speed", () => {
  it("starts at the library's default when the player was closed, and at normal speed when there is none", async () => {
    defaults.set("fast", 1.5);
    const p = newPlayer();
    await p.actions.load("plain", { autoplay: false });
    expect(state.rate).toBe(1);
    p.actions.close();
    await p.actions.load("fast", { autoplay: false });
    expect(state.rate).toBe(1.5);
  });
  it("lets the listener change it (0.25 to 3, custom values too), and keeps it from one book or song to the next", async () => {
    defaults.set("a", 1.25);
    const p = newPlayer();
    await p.actions.load("a", { autoplay: false });
    p.actions.setRate(1.35);
    expect(state.rate).toBe(1.35);
    p.actions.setRate(0.1);
    expect(state.rate).toBe(0.25);
    p.actions.setRate(7);
    expect(state.rate).toBe(3);
    p.actions.setRate(1.8);
    defaults.set("b", 1);
    await p.actions.load("b", { autoplay: false }); // another book while the player stays open: the speed in use carries on
    expect(state.rate).toBe(1.8);
  });
  it("resets when the player is closed, so the next start uses that library's default again", async () => {
    defaults.set("a", 1.25);
    defaults.set("b", 2);
    const p = newPlayer();
    await p.actions.load("a", { autoplay: false });
    p.actions.setRate(2.75);
    p.actions.close();
    expect(state.rate).toBe(1);
    await p.actions.load("b", { autoplay: false });
    expect(state.rate).toBe(2);
    p.actions.close();
    await p.actions.load("a", { autoplay: false });
    expect(state.rate).toBe(1.25);
  });
  it("is applied to the audio element, and never saved (no request to a profile-speed endpoint, nothing in local storage)", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    const p = newPlayer();
    await p.actions.load("a", { autoplay: true });
    p.actions.setRate(2.5);
    expect(p.el.playbackRate).toBe(2.5);
    await new Promise((r) => setTimeout(r, 800)); // longer than the old save delay
    expect(calls.some((c) => c.includes("playback-rate"))).toBe(false);
    expect(store.size).toBe(0);
  });
});
