/** Matching a music library's albums against MusicBrainz, with a stand-in client (no network). */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { musicAlbums, musicArtists, titles } from "@/lib/db/schema";
import { artworkOf, makeAccount, makeLibrary, makeServer, putArtwork, type TestDb } from "@/lib/playlists/test-db";
import { MUSIC_PROFILE } from "@/lib/scan/tree-profile";
import { syncVideoDirectory } from "@/lib/scan/video-library";
import { TEST_JPEG } from "@/lib/scan/test-mp4";
import type { MusicBrainzClient, ReleaseCandidate } from "./musicbrainz";
import { MAX_MATCH_ATTEMPTS, enrichMusicLibrary } from "./enrich";
import { organizeMusicLibrary } from "./organize";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const RID = "11111111-2222-3333-4444-555555555555";
let n = 0;
async function album(names = ["01 - first.mp3", "02 - second.mp3"], folder = "beatles/abbey road") {
  const admin = await makeAccount(db, "e");
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "music", "everyone");
  const prefix = `enr${++n}-`;
  await syncVideoDirectory(lib.id, "p", folder, names.map((name, i) => ({ id: `${prefix}${i}`, name, kind: "file" as const, sizeBytes: 10 })), null, MUSIC_PROFILE);
  await organizeMusicLibrary(lib.id);
  const tracks = () => db.select().from(titles).where(eq(titles.libraryId, lib.id));
  const albumRow = async () => (await db.select().from(musicAlbums).where(eq(musicAlbums.libraryId, lib.id)))[0];
  const artistRow = async () => (await db.select().from(musicArtists).where(eq(musicArtists.libraryId, lib.id)))[0];
  return { lib, tracks, albumRow, artistRow };
}

const candidate = (over: Partial<ReleaseCandidate> = {}): ReleaseCandidate => ({ id: RID, title: "Abbey Road", artist: "The Beatles", score: 100, trackCount: 2, date: "1969-09-26", status: "Official", country: "GB", ...over });
function client(over: Partial<MusicBrainzClient> = {}): MusicBrainzClient & { calls: { search: number; release: number; cover: number } } {
  const calls = { search: 0, release: 0, cover: 0 };
  return {
    calls,
    searchReleases: async () => (calls.search++, [candidate()]),
    getRelease: async () => (
      calls.release++,
      { id: RID, title: "Abbey Road", artist: "The Beatles", artistId: "artist-1", date: "1969-09-26", tracks: [{ disc: 1, position: 1, title: "Come Together", recordingId: null }, { disc: 1, position: 2, title: "Something", recordingId: null }] }
    ),
    getFrontCover: async () => (calls.cover++, { contentType: "image/jpeg" as const, bytes: Uint8Array.from(TEST_JPEG) }),
    ...over,
  };
}
const run = (id: string, c: MusicBrainzClient, errors: string[] = [], opts: { now?: () => Date; deadline?: number } = {}) =>
  enrichMusicLibrary(id, opts.deadline ?? Date.now() + 60_000, errors, { client: c, now: opts.now });

describe("enrichMusicLibrary", () => {
  it("takes the release's name, year, ids, track titles and cover for a clear match", async () => {
    const a = await album(["01 - first.mp3", "02 - second.mp3"]);
    // first.mp3 and second.mp3 don't resemble the release titles: they must NOT be renamed by position alone.
    const c = client();
    await run(a.lib.id, c);
    expect(await a.albumRow()).toMatchObject({ name: "Abbey Road", year: 1969, mbid: RID, matchStatus: "matched", matchedTrackCount: 2, matchAttempts: 1 });
    expect((await a.artistRow()).mbid).toBe("artist-1");
    expect((await a.tracks()).map((t) => t.name).sort()).toEqual(["first", "second"]);
  });

  it("renames songs whose name came from the file name and matches the release's title, but never one from the file's tags", async () => {
    const a = await album(["01 - come together.mp3", "02 - something.mp3"]);
    const [t1] = (await a.tracks()).filter((t) => t.trackNumber === 2);
    await db.update(titles).set({ name: "Something!", nameSource: "embedded" }).where(eq(titles.id, t1.id));
    await run(a.lib.id, client());
    const byNumber = Object.fromEntries((await a.tracks()).map((t) => [t.trackNumber, [t.name, t.nameSource]]));
    expect(byNumber[1]).toEqual(["Come Together", "online"]);
    expect(byNumber[2]).toEqual(["Something!", "embedded"]);
  });

  it("gives the cover to songs without a picture, leaves a song's own cover alone, and marks it as online", async () => {
    const a = await album(["01 - come together.mp3", "02 - something.mp3"]);
    const own = (await a.tracks()).find((t) => t.trackNumber === 1)!;
    await putArtwork(db, own.id, [9, 9, 9], "image/jpeg", "embedded");
    await run(a.lib.id, client());
    const [mine, other] = [await artworkOf(db, own.id), await artworkOf(db, (await a.tracks()).find((t) => t.trackNumber === 2)!.id)];
    expect([mine!.source, Array.from(mine!.bytes)]).toEqual(["embedded", [9, 9, 9]]);
    expect([other!.source, Array.from(other!.bytes)]).toEqual(["online", TEST_JPEG]);
    expect((await a.tracks()).find((t) => t.trackNumber === 2)!.posterUrl).toContain("/artwork");
  });

  it("does nothing to an album with no clear match, and does not look again", async () => {
    const a = await album();
    const c = client({ searchReleases: async () => [candidate({ artist: "Somebody Else" })] });
    await run(a.lib.id, c);
    expect(await a.albumRow()).toMatchObject({ name: "abbey road", matchStatus: "unmatched", mbid: null });
    const again = client();
    await run(a.lib.id, again);
    expect(again.calls.search).toBe(0);
  });

  it("does not ask again for a matched album unless its number of songs changed", async () => {
    const a = await album(["01 - come together.mp3", "02 - something.mp3"]);
    await run(a.lib.id, client());
    const quiet = client();
    await run(a.lib.id, quiet);
    expect(quiet.calls.search).toBe(0);
    await syncVideoDirectory(a.lib.id, "p", "beatles/abbey road", [{ id: `enr-new-${n}`, name: "03 - new.mp3", kind: "file", sizeBytes: 10 }], null, MUSIC_PROFILE);
    await organizeMusicLibrary(a.lib.id);
    const loud = client({ searchReleases: async () => [candidate({ trackCount: 3 })] });
    await run(a.lib.id, loud);
    expect(loud.calls.release).toBe(1);
    expect((await a.albumRow()).matchedTrackCount).toBe(3);
  });

  it("keeps an album's match when a song is added that the release can't hold (a bonus track), and doesn't keep asking", async () => {
    const a = await album(["01 - come together.mp3", "02 - something.mp3"]);
    await run(a.lib.id, client());
    await syncVideoDirectory(a.lib.id, "p", "beatles/abbey road", [{ id: `enr-bonus-${n}`, name: "03 - bonus.mp3", kind: "file", sizeBytes: 10 }], null, MUSIC_PROFILE);
    await organizeMusicLibrary(a.lib.id);
    await run(a.lib.id, client()); // the release has 2 tracks; we now have 3
    expect(await a.albumRow()).toMatchObject({ name: "Abbey Road", matchStatus: "matched", mbid: RID, matchedTrackCount: 3 });
    const quiet = client();
    await run(a.lib.id, quiet);
    expect(quiet.calls.search).toBe(0);
  });

  it("keeps the matched year and name through later grouping passes, and through a rescan of the files", async () => {
    const a = await album(["01 - come together.mp3", "02 - something.mp3"]);
    await db.update(titles).set({ year: 2001 }).where(eq(titles.libraryId, a.lib.id));
    await run(a.lib.id, client());
    await organizeMusicLibrary(a.lib.id);
    expect(await a.albumRow()).toMatchObject({ name: "Abbey Road", year: 1969 });
    const t = (await a.tracks()).find((x) => x.trackNumber === 1)!;
    await syncVideoDirectory(a.lib.id, "p", "beatles/abbey road", [{ id: t.boxFolderId.slice(5), name: "01 - come together.mp3", kind: "file", sizeBytes: 10 }], null, MUSIC_PROFILE);
    expect((await a.tracks()).find((x) => x.trackNumber === 1)!.name).toBe("Come Together");
  });

  it("records a failure, waits before trying again, and gives up after a few tries without touching the album", async () => {
    const a = await album();
    const boom = client({ searchReleases: async () => { throw new Error("MusicBrainz answered 500"); } });
    const errors: string[] = [];
    let clock = new Date("2026-01-01T00:00:00Z");
    expect(await run(a.lib.id, boom, errors, { now: () => clock })).toBe(true);
    expect(errors[0]).toContain("music lookup beatles / abbey road: MusicBrainz answered 500");
    expect(await a.albumRow()).toMatchObject({ matchStatus: "pending", matchAttempts: 1, name: "abbey road" });
    await run(a.lib.id, boom, errors, { now: () => new Date(clock.getTime() + 60_000) }); // too soon: skipped
    expect((await a.albumRow()).matchAttempts).toBe(1);
    for (let i = 1; i < MAX_MATCH_ATTEMPTS; i++) {
      clock = new Date(clock.getTime() + 24 * 3600_000);
      await run(a.lib.id, boom, errors, { now: () => clock });
    }
    expect(await a.albumRow()).toMatchObject({ matchStatus: "unmatched", matchAttempts: MAX_MATCH_ATTEMPTS });
  });

  it("a cover that cannot be fetched still lets the rest of the match through", async () => {
    const a = await album(["01 - come together.mp3", "02 - something.mp3"]);
    await run(a.lib.id, client({ getFrontCover: async () => { throw new Error("archive down"); } }));
    expect(await a.albumRow()).toMatchObject({ matchStatus: "matched" });
    expect((await a.tracks()).every((t) => t.posterUrl === null)).toBe(true);
  });

  it("stops when its time is up", async () => {
    const a = await album();
    const c = client();
    expect(await run(a.lib.id, c, [], { deadline: Date.now() - 1 })).toBe(true);
    expect(c.calls.search).toBe(0);
  });

  it("only touches the library it was asked about", async () => {
    const [a, b] = [await album(), await album()];
    await run(a.lib.id, client());
    expect((await b.albumRow()).matchStatus).toBe("pending");
  });
});
