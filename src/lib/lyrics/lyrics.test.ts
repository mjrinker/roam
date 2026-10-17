import { describe, expect, it, vi } from "vitest";
import { lineAt, parseLrc } from "./lrc";
import { findLyrics } from "./lrclib";

describe("LRC", () => {
  it("reads timed lines in order, with repeated times and tags ignored", () => {
    const lines = parseLrc("[ar:Someone]\n[ti:Song]\n[00:12.50] Second\n[00:01.00]First\n[00:30.00][01:00.5]Chorus\nno time here\n[02:03] Last\r\n");
    expect(lines).toEqual([
      { t: 1, text: "First" },
      { t: 12.5, text: "Second" },
      { t: 30, text: "Chorus" },
      { t: 60.5, text: "Chorus" },
      { t: 123, text: "Last" },
    ]);
  });
  it("finds the line being sung", () => {
    const lines = parseLrc("[00:10.00]a\n[00:20.00]b\n[00:30.00]c");
    expect([0, 9.99, 10, 25, 30, 99].map((t) => lineAt(lines, t))).toEqual([-1, -1, 0, 1, 2, 2]);
    expect(lineAt(lines, 12, 3)).toBe(-1); // shifted later by 3 seconds
    expect(lineAt([], 5)).toBe(-1);
  });
  it("copes with nothing, and caps what it keeps", () => {
    expect(parseLrc("")).toEqual([]);
    expect(parseLrc(Array.from({ length: 3000 }, (_, i) => `[00:${String(i % 60).padStart(2, "0")}]x`).join("\n"))).toHaveLength(2000);
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const song = { title: "Song", artist: "Band", album: "Record", durationSeconds: 200.4 };

describe("LRCLIB", () => {
  it("asks for the exact song first, saying who is asking", async () => {
    const f = vi.fn(async () => json({ syncedLyrics: "[00:01.00]hi", plainLyrics: "hi", instrumental: false }));
    expect(await findLyrics(song, f as never)).toEqual({ synced: "[00:01.00]hi", plain: "hi", instrumental: false });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://lrclib.net/api/get?track_name=Song&artist_name=Band&album_name=Record&duration=200");
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain("Roam");
  });
  it("searches when there is no exact match, taking a song of about the same length, preferring timed words", async () => {
    const f = vi.fn(async (url: string) =>
      url.includes("/get?")
        ? json({}, 404)
        : json([
            { duration: 400, syncedLyrics: "[00:01]long", plainLyrics: "long" },
            { duration: 201, plainLyrics: "plain only" },
            { duration: 199, syncedLyrics: "[00:02.00]timed", plainLyrics: "timed" },
          ])
    );
    expect(await findLyrics(song, f as never)).toEqual({ synced: "[00:02.00]timed", plain: "timed", instrumental: false });
    expect(await findLyrics({ ...song, album: null }, f as never)).toMatchObject({ plain: "timed" }); // no album: straight to the search
  });
  it("uses the same song's words for a file that is only a clip of it, taking the nearest longer recording, never a different title or version", async () => {
    const clip = { ...song, title: "Rolling in the Deep", artist: "Adele", album: "21", durationSeconds: 40 };
    const f = vi.fn(async (url: string) =>
      url.includes("/get?")
        ? json({}, 404)
        : json([
            { trackName: "Rolling in the Deep (Live)", artistName: "Adele", duration: 500, syncedLyrics: "[00:01]live" },
            { trackName: "Rolling in the Deep", artistName: "Someone Else", duration: 228, syncedLyrics: "[00:01]cover" },
            { trackName: "Rolling In The Deep [Remastered]", artistName: "ADELE", duration: 240, plainLyrics: "plain" },
            { trackName: "Rolling in the Deep", artistName: "Adele", duration: 228, syncedLyrics: "[00:03.00]timed", plainLyrics: "timed" },
            { trackName: "Another Song", artistName: "Adele", duration: 100, syncedLyrics: "[00:01]no" },
          ])
    );
    expect(await findLyrics(clip, f as never)).toEqual({ synced: "[00:03.00]timed", plain: "timed", instrumental: false });
    // a file as long as the recording, or longer, is a different version: not matched by title alone
    expect(await findLyrics({ ...clip, durationSeconds: 300 }, f as never)).toBeNull();
    // too short to be a clip of anything, or no length at all
    expect(await findLyrics({ ...clip, durationSeconds: 3 }, f as never)).toBeNull();
    expect(await findLyrics({ ...clip, durationSeconds: null }, f as never)).toMatchObject({ synced: "[00:01]live" }); // unchanged: no length means any will do
  });
  it("is null when nothing is there, and can say a song is an instrumental", async () => {
    expect(await findLyrics(song, (async () => json({}, 404)) as never)).toBeNull();
    expect(await findLyrics(song, (async (u: string) => (u.includes("/get?") ? json({}, 404) : json([{ duration: 200, instrumental: true }]))) as never)).toEqual({ synced: null, plain: null, instrumental: true });
    expect(await findLyrics({ ...song, title: " " }, vi.fn() as never)).toBeNull();
    expect(await findLyrics({ ...song, artist: "" }, vi.fn() as never)).toBeNull();
  });
  it("throws when the service is down, so the caller can try again later", async () => {
    await expect(findLyrics(song, (async () => json({}, 503)) as never)).rejects.toThrow();
  });
});
