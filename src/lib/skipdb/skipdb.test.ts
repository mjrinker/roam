import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeSkipButton, NEXT_FALLBACK_SECONDS } from "./active";
import { parseSegments, resetSkipdbMemory, skipSegmentsFor, skipdbBase } from "./client";

const body = (segments: object) => ({ imdb_id: "tt0903747", season: 1, episode: 1, segments });
const seg = (start_ms: number, end_ms: number, over: object = {}) => ({ start_ms, end_ms, adjusted: false, offset_ms: 0, match: "agnostic", confidence: 0.75, ...over });

describe("skipdbBase", () => {
  it("is their address by default, can be pointed elsewhere (https only), and can be switched off", () => {
    expect(skipdbBase({})).toBe("https://api.skipdb.tv");
    expect(skipdbBase({ SKIPDB_URL: "https://skip.example.org/" })).toBe("https://skip.example.org");
    expect(skipdbBase({ SKIPDB_URL: "off" })).toBeNull();
    expect(skipdbBase({ SKIPDB_URL: "http://insecure.example.org" })).toBeNull();
    expect(skipdbBase({ SKIPDB_URL: "not a url" })).toBeNull();
  });
});

describe("parseSegments", () => {
  it("reads their answer into seconds, sorted by start", () => {
    const out = parseSegments(body({ intro: seg(229500, 246500), recap: null, outro: seg(3434000, 3500000), preview: null }), 3600);
    expect(out).toEqual([{ kind: "intro", startSeconds: 229.5, endSeconds: 246.5 }, { kind: "outro", startSeconds: 3434, endSeconds: 3500 }]);
  });
  it("leaves out what can't be right", () => {
    const out = parseSegments(body({ intro: seg(10_000, 11_000), recap: seg(0, 900_000), outro: seg(1000, 500, {}), preview: seg(100_000, 130_000, { confidence: 0.2 }) }), 3600);
    expect(out).toEqual([]); // too short, too long for a recap, ends before it starts, and not confident
  });
  it("cuts a segment that runs past the video at the video's end, and survives nonsense", () => {
    expect(parseSegments(body({ outro: seg(3400_000, 4000_000) }), 3600)[0]).toEqual({ kind: "outro", startSeconds: 3400, endSeconds: 3600 });
    for (const bad of [null, undefined, "x", {}, { segments: null }, { segments: { intro: "no" } }, { segments: { intro: { start_ms: "1", end_ms: 2 } } }]) expect(parseSegments(bad, 100)).toEqual([]);
  });
});

describe("skipSegmentsFor", () => {
  beforeEach(() => resetSkipdbMemory());
  const ok = (b: unknown) => vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(b), { status: 200 }));
  it("asks with the show, the season, the episode and the video's length, and remembers the answer", async () => {
    const f = ok(body({ intro: seg(61_000, 91_000) }));
    const t = { imdbId: "tt0903747", season: 1, episode: 2 };
    expect(await skipSegmentsFor(t, 2820, { fetchImpl: f as never, env: {} })).toHaveLength(1);
    const url = new URL(String(f.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/segments");
    expect(Object.fromEntries(url.searchParams)).toEqual({ imdb_id: "tt0903747", season: "1", episode: "2", duration: "2820" });
    await skipSegmentsFor(t, 2822, { fetchImpl: f as never, env: {} }); // about the same length: not asked again
    expect(f).toHaveBeenCalledTimes(1);
    await skipSegmentsFor({ ...t, episode: 3 }, 2820, { fetchImpl: f as never, env: {} });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("asks about a movie by its IMDb id alone", async () => {
    const f = ok(body({ outro: seg(7000_000, 7200_000) }));
    await skipSegmentsFor({ imdbId: "tt0133093" }, 7300, { fetchImpl: f as never, env: {} });
    expect(Object.fromEntries(new URL(String(f.mock.calls[0][0])).searchParams)).toEqual({ imdb_id: "tt0133093", duration: "7300" });
  });
  it("asks nothing when switched off, without an IMDb id, or for something too short to be a film", async () => {
    const f = ok(body({}));
    expect(await skipSegmentsFor({ imdbId: "tt0903747" }, 3000, { fetchImpl: f as never, env: { SKIPDB_URL: "off" } })).toEqual([]);
    expect(await skipSegmentsFor({ imdbId: null }, 3000, { fetchImpl: f as never, env: {} })).toEqual([]);
    expect(await skipSegmentsFor({ imdbId: "../../etc" }, 3000, { fetchImpl: f as never, env: {} })).toEqual([]);
    expect(await skipSegmentsFor({ imdbId: "tt0903747" }, 30, { fetchImpl: f as never, env: {} })).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
  it("gives no buttons, and doesn't throw or retry at once, when they can't be reached", async () => {
    const down = vi.fn(async () => { throw new Error("offline"); });
    expect(await skipSegmentsFor({ imdbId: "tt0903747" }, 3000, { fetchImpl: down as never, env: {} })).toEqual([]);
    expect(await skipSegmentsFor({ imdbId: "tt0903747" }, 3000, { fetchImpl: down as never, env: {} })).toEqual([]);
    expect(down).toHaveBeenCalledTimes(1);
    const bad = vi.fn(async () => new Response("no", { status: 500 }));
    expect(await skipSegmentsFor({ imdbId: "tt0000001" }, 3000, { fetchImpl: bad as never, env: {} })).toEqual([]);
  });
});

describe("activeSkipButton", () => {
  const segs = [{ kind: "recap" as const, startSeconds: 0, endSeconds: 60 }, { kind: "intro" as const, startSeconds: 200, endSeconds: 250 }, { kind: "outro" as const, startSeconds: 2500, endSeconds: 2620 }];
  it("offers to skip an intro or recap while it plays, to its end", () => {
    expect(activeSkipButton(segs, 10, 2700, false)).toEqual({ action: "seek", label: "Skip recap", toSeconds: 60, fromSkipdb: true });
    expect(activeSkipButton(segs, 199.6, 2700, false)).toMatchObject({ label: "Skip intro", toSeconds: 250 });
    expect(activeSkipButton(segs, 100, 2700, false)).toBeNull();
    expect(activeSkipButton(segs, 249, 2700, false)).toBeNull(); // about to end anyway
  });
  it("offers the next episode in the credits when there is one, else a way past the credits", () => {
    expect(activeSkipButton(segs, 2510, 2700, true)).toMatchObject({ action: "next", label: "Next episode" });
    expect(activeSkipButton(segs, 2510, 2700, false)).toMatchObject({ action: "seek", label: "Skip credits", toSeconds: 2620 });
    expect(activeSkipButton([{ kind: "outro", startSeconds: 2500, endSeconds: 2700 }], 2600, 2700, false)).toMatchObject({ toSeconds: 2699.5 });
  });
  it("with no credits time known, offers the next episode for the last stretch", () => {
    expect(activeSkipButton([], 2700 - NEXT_FALLBACK_SECONDS + 1, 2700, true)).toMatchObject({ action: "next", fromSkipdb: false });
    expect(activeSkipButton([], 1000, 2700, true)).toBeNull();
    expect(activeSkipButton([], 2690, 2700, false)).toBeNull(); // nothing next
    expect(activeSkipButton(undefined, 2690, 2700, true)).not.toBeNull();
    expect(activeSkipButton(segs, 2650, 2700, true)).toBeNull(); // credits are known; the fallback is not used
  });
});
