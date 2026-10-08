import { describe, expect, it, vi } from "vitest";
import { createMusicBrainz, luceneQuote, mapTracks, nameSimilarity, normalizeName, pickRelease, sameArtist, yearOfDate, type ReleaseCandidate } from "./musicbrainz";

describe("names", () => {
  it("normalizes accents, case, punctuation and ampersands", () => {
    expect(normalizeName("  Frédéric  CHOPIN! ")).toBe("frederic chopin");
    expect(normalizeName("Simon & Garfunkel")).toBe("simon and garfunkel");
    expect(normalizeName("AC/DC")).toBe("ac dc");
  });
  it("compares albums by the share of words they have in common", () => {
    expect(nameSimilarity("Abbey Road", "abbey road")).toBe(1);
    expect(nameSimilarity("Abbey Road", "Abbey Road (Remastered)")).toBeCloseTo(2 / 3);
    expect(nameSimilarity("Abbey Road", "Let It Be")).toBe(0);
    expect(nameSimilarity("", "x")).toBe(0);
  });
  it("matches an artist folder to an artist when every word of the shorter is in the longer, but not on a lone 'the'", () => {
    expect(sameArtist("Chopin", "Frédéric Chopin")).toBe(true);
    expect(sameArtist("beatles", "The Beatles")).toBe(true);
    expect(sameArtist("The Beatles", "Beatles")).toBe(true);
    expect(sameArtist("Beatles", "The Beetles")).toBe(false);
    expect(sameArtist("The", "The Who")).toBe(false);
    expect(sameArtist("Queen", "Queens of the Stone Age")).toBe(false);
    expect(sameArtist("", "X")).toBe(false);
    expect(sameArtist("Bach", "Johann Sebastian Bach")).toBe(true);
    expect(sameArtist("Bach", "Bachman Turner Overdrive")).toBe(false);
  });
  it("reads years", () => {
    expect([yearOfDate("1969-09-26"), yearOfDate("1969"), yearOfDate("1969-09"), yearOfDate(""), yearOfDate(null), yearOfDate("n/a"), yearOfDate("0001-01-01")]).toEqual([1969, 1969, 1969, null, null, null, null]);
  });
  it("quotes search phrases so users' names cannot add search syntax", () => {
    expect(luceneQuote('He said "hi" \\ OR artist:x')).toBe('"He said \\"hi\\" \\\\ OR artist:x"');
  });
});

const rel = (over: Partial<ReleaseCandidate> = {}): ReleaseCandidate => ({ id: "a", title: "Abbey Road", artist: "The Beatles", score: 100, trackCount: 17, date: "1969-09-26", status: "Official", country: "GB", ...over });

describe("pickRelease", () => {
  const want = { artist: "Beatles", album: "Abbey Road", trackCount: 17 };
  it("takes a clear match", () => {
    expect(pickRelease([rel()], want)?.id).toBe("a");
  });
  it("refuses a wrong artist, a different album, a low score, and a release too short to hold our tracks", () => {
    expect(pickRelease([rel({ artist: "Some Cover Band" })], want)).toBeNull();
    expect(pickRelease([rel({ title: "Let It Be" })], want)).toBeNull();
    expect(pickRelease([rel({ score: 79 })], want)).toBeNull();
    expect(pickRelease([rel({ trackCount: 10 })], want)).toBeNull();
    expect(pickRelease([], want)).toBeNull();
  });
  it("accepts a release with an unknown track count", () => {
    expect(pickRelease([rel({ trackCount: null })], want)?.id).toBe("a");
  });
  it("prefers the same track count, then official, then the closer name, then the earlier date, then the id (deterministic)", () => {
    expect(pickRelease([rel({ id: "big", trackCount: 20 }), rel({ id: "exact" })], want)?.id).toBe("exact");
    expect(pickRelease([rel({ id: "promo", status: "Promotion" }), rel({ id: "official" })], want)?.id).toBe("official");
    expect(pickRelease([rel({ id: "remaster", title: "Abbey Road (Remastered)" }), rel({ id: "plain" })], want)?.id).toBe("plain");
    expect(pickRelease([rel({ id: "late", date: "2019-09-27" }), rel({ id: "early" })], want)?.id).toBe("early");
    expect(pickRelease([rel({ id: "undated", date: null }), rel({ id: "emptydate", date: "" }), rel({ id: "dated", date: "2019-09-27" })], want)?.id).toBe("dated");
    expect(pickRelease([rel({ id: "b" }), rel({ id: "a" })], want)?.id).toBe("a");
    expect(pickRelease([rel({ id: "a" }), rel({ id: "b" })], want)?.id).toBe("a");
  });
});

describe("mapTracks", () => {
  const release = [
    { disc: 1, position: 1, title: "Come Together", recordingId: "r1" },
    { disc: 1, position: 2, title: "Something", recordingId: "r2" },
  ];
  it("pairs by track number when the names agree", () => {
    const m = mapTracks([{ id: "t1", disc: null, track: 1, name: "come together" }, { id: "t2", disc: null, track: 2, name: "Something" }], release);
    expect([...m].map(([id, r]) => [id, r.title])).toEqual([["t1", "Come Together"], ["t2", "Something"]]);
  });
  it("does not give a song another's title when the numbering disagrees with the name", () => {
    expect(mapTracks([{ id: "t1", disc: null, track: 1, name: "Something" }], release).size).toBe(0);
  });
  it("skips tracks with no number, and positions the release lists twice", () => {
    expect(mapTracks([{ id: "t", disc: null, track: null, name: "Something" }], release).size).toBe(0);
    expect(mapTracks([{ id: "t", disc: null, track: 1, name: "Come Together" }], [...release, { disc: 1, position: 1, title: "Come Together", recordingId: null }]).size).toBe(0);
  });
  it("uses the disc only when the release has more than one", () => {
    const two = [{ disc: 1, position: 1, title: "One", recordingId: null }, { disc: 2, position: 1, title: "Two", recordingId: null }];
    const m = mapTracks([{ id: "a", disc: 2, track: 1, name: "Two" }, { id: "b", disc: null, track: 1, name: "One" }], two);
    expect([...m].map(([id, r]) => [id, r.title])).toEqual([["a", "Two"], ["b", "One"]]);
    expect(mapTracks([{ id: "x", disc: 2, track: 1, name: "One" }], release).get("x")).toBeUndefined(); // names disagree, so no pairing
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createMusicBrainz", () => {
  const fast = { sleep: async () => undefined };
  it("searches with a quoted query, a descriptive user agent, and maps the answer", async () => {
    const f = vi.fn(async () => json({ releases: [{ id: "id1", title: "Abbey Road", score: 100, "track-count": 17, date: "1969", status: "Official", "artist-credit": [{ name: "The Beatles" }] }] }));
    const mb = createMusicBrainz({ fetch: f as never, ...fast });
    const out = await mb.searchReleases('The "Beatles"', "Abbey Road");
    expect(out).toEqual([{ id: "id1", title: "Abbey Road", artist: "The Beatles", score: 100, trackCount: 17, date: "1969", status: "Official", country: null }]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(decodeURIComponent(url)).toContain('release:"Abbey Road" AND artist:"The \\"Beatles\\""');
    expect((init.headers as Record<string, string>)["user-agent"]).toMatch(/Roam\/1\.0 \(https:\/\/github\.com/);
  });
  it("spaces requests out, one at a time", async () => {
    let clock = 0;
    const times: number[] = [];
    const f = vi.fn(async () => (times.push(clock), json({ releases: [] })));
    const mb = createMusicBrainz({ fetch: f as never, now: () => clock, sleep: async (ms) => void (clock += ms), minIntervalMs: 1000 });
    await Promise.all([mb.searchReleases("a", "b"), mb.searchReleases("c", "d"), mb.searchReleases("e", "f")]);
    expect(times.slice(1).map((t, i) => t - times[i])).toEqual([1000, 1000]);
  });
  it("waits and retries when rate limited, then gives up with a clear error", async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(json({ releases: [] }));
    expect(await createMusicBrainz({ fetch: f as never, ...fast }).searchReleases("a", "b")).toEqual([]);
    const always = vi.fn(async () => new Response("", { status: 503 }));
    await expect(createMusicBrainz({ fetch: always as never, ...fast }).searchReleases("a", "b")).rejects.toThrow(/busy/);
    expect(always).toHaveBeenCalledTimes(3);
  });
  it("fails on other errors", async () => {
    await expect(createMusicBrainz({ fetch: (async () => new Response("", { status: 500 })) as never, ...fast }).searchReleases("a", "b")).rejects.toThrow(/500/);
  });
  it("reads a release's tracks by disc and position, and a single credited artist's id", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const f = vi.fn(async () => json({ id, title: "T", date: "2000-01-01", "artist-credit": [{ name: "A", artist: { id: "art", name: "A" } }], media: [{ position: 1, tracks: [{ position: 1, title: "One", recording: { id: "rec" } }, { title: "no position" }] }] }));
    const rel2 = await createMusicBrainz({ fetch: f as never, ...fast }).getRelease(id);
    expect(rel2).toEqual({ id, title: "T", artist: "A", artistId: "art", date: "2000-01-01", tracks: [{ disc: 1, position: 1, title: "One", recordingId: "rec" }] });
  });
  it("returns null for an unknown release and refuses an id that is not one", async () => {
    const mb = createMusicBrainz({ fetch: (async () => new Response("", { status: 404 })) as never, ...fast });
    expect(await mb.getRelease("11111111-2222-3333-4444-555555555555")).toBeNull();
    await expect(mb.getRelease("../etc/passwd")).rejects.toThrow(/Not a MusicBrainz id/);
    await expect(mb.getFrontCover("x?y")).rejects.toThrow(/Not a MusicBrainz id/);
  });
  it("takes a front cover that is a JPEG or PNG of sane size, and nothing else", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const img = (type: string, size = 100) => (async () => new Response(new Uint8Array(size), { status: 200, headers: { "content-type": type } })) as never;
    expect((await createMusicBrainz({ fetch: img("image/jpeg") }).getFrontCover(id))?.contentType).toBe("image/jpeg");
    expect(await createMusicBrainz({ fetch: img("image/svg+xml") }).getFrontCover(id)).toBeNull();
    expect(await createMusicBrainz({ fetch: img("text/html") }).getFrontCover(id)).toBeNull();
    expect(await createMusicBrainz({ fetch: img("image/png", 0) }).getFrontCover(id)).toBeNull();
    expect(await createMusicBrainz({ fetch: img("image/png", 4 * 1024 * 1024) }).getFrontCover(id)).toBeNull();
    expect(await createMusicBrainz({ fetch: (async () => new Response("", { status: 404 })) as never }).getFrontCover(id)).toBeNull();
    await expect(createMusicBrainz({ fetch: (async () => new Response("", { status: 500 })) as never }).getFrontCover(id)).rejects.toThrow(/500/);
  });
});
