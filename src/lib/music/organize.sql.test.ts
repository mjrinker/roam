/** Grouping a music library's tracks into artists and albums from their folders. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

vi.mock("@/lib/scan/media-files", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/scan/media-files")>();
  return { ...original, probeFiles: vi.fn(async () => false), probeCodecsForPending: vi.fn(async () => undefined) };
});

vi.mock("@/lib/music/enrich", () => ({ enrichMusicLibrary: vi.fn(async () => false) }));

import { libraries, mediaFiles, musicAlbums, musicArtists, titles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { MUSIC_PROFILE } from "@/lib/scan/tree-profile";
import { probeVideoLibrary, syncVideoDirectory } from "@/lib/scan/video-library";
import { pruneMissingVideos, pruneSettings } from "@/lib/scan/video-prune";
import type { StorageProvider } from "@/lib/storage/provider";
import { organizeMusicLibrary, sweepEmptyMusicGroups } from "./organize";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let n = 0;
async function newLibrary() {
  const admin = await makeAccount(db, "m");
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, "music", "everyone");
  const prefix = `mus${++n}-`;
  let i = 0;
  /** Puts files in a folder of the library, like a scan of that directory would. */
  const add = (folderPath: string, names: string[]) =>
    syncVideoDirectory(lib.id, "p", folderPath, names.map((name) => ({ id: `${prefix}${i++}`, name, kind: "file" as const, sizeBytes: 10 })), null, MUSIC_PROFILE);
  const view = async () => {
    const artists = await db.select().from(musicArtists).where(eq(musicArtists.libraryId, lib.id));
    const albums = await db.select().from(musicAlbums).where(eq(musicAlbums.libraryId, lib.id));
    const tracks = await db.select().from(titles).where(eq(titles.libraryId, lib.id));
    const artistName = (id: string) => artists.find((a) => a.id === id)!.name;
    return {
      artists: artists.map((a) => a.name).sort(),
      albums: albums.map((a) => `${artistName(a.artistId)} / ${a.name}`).sort(),
      tracks: tracks
        .map((t) => ({ name: t.name, album: t.albumId ? albums.find((a) => a.id === t.albumId)?.name : null, track: t.trackNumber, disc: t.discNumber }))
        .sort((a, b) => `${a.album}${a.disc}${a.track}`.localeCompare(`${b.album}${b.disc}${b.track}`)),
      raw: { artists, albums, tracks },
    };
  };
  return { lib, add, view };
}

describe("organizeMusicLibrary", () => {
  it("makes an artist and an album per folder, numbers the tracks and names them without the number", async () => {
    const m = await newLibrary();
    await m.add("Chopin/Ballades", ["02 - Second.mp3", "01 - First.mp3"]);
    await m.add("Chopin/Waltzes", ["01 Grande.mp3"]);
    await m.add("Bach/Cello Suites", ["01. Prelude.m4a"]);
    expect(await organizeMusicLibrary(m.lib.id)).toEqual({ placed: 4, complete: true });
    const v = await m.view();
    expect(v.artists).toEqual(["Bach", "Chopin"]);
    expect(v.albums).toEqual(["Bach / Cello Suites", "Chopin / Ballades", "Chopin / Waltzes"]);
    expect(v.tracks).toEqual([
      { name: "Prelude", album: "Cello Suites", track: 1, disc: null },
      { name: "First", album: "Ballades", track: 1, disc: null },
      { name: "Second", album: "Ballades", track: 2, disc: null },
      { name: "Grande", album: "Waltzes", track: 1, disc: null },
    ].sort((a, b) => `${a.album}${a.disc}${a.track}`.localeCompare(`${b.album}${b.disc}${b.track}`)));
  });

  it("is idempotent: a second run changes nothing and makes no duplicates", async () => {
    const m = await newLibrary();
    await m.add("A/B", ["01 - x.mp3", "02 - y.mp3"]);
    await organizeMusicLibrary(m.lib.id);
    const before = await m.view();
    expect(await organizeMusicLibrary(m.lib.id)).toEqual({ placed: 0, complete: true });
    const after = await m.view();
    expect(after.raw.artists.map((a) => a.id)).toEqual(before.raw.artists.map((a) => a.id));
    expect(after.raw.albums.map((a) => a.id)).toEqual(before.raw.albums.map((a) => a.id));
  });

  it("reads discs from disc folders and from the file name", async () => {
    const m = await newLibrary();
    await m.add("A/Double", ["01 - a.mp3"]);
    await m.add("A/Double/CD2", ["01 - b.mp3"]);
    await m.add("A/Other", ["2-03 - c.mp3"]);
    await organizeMusicLibrary(m.lib.id);
    const v = await m.view();
    expect(v.albums).toEqual(["A / Double", "A / Other"]);
    expect(v.tracks.map((t) => `${t.album}:${t.disc}:${t.track}`).sort()).toEqual(["Double:2:1", "Double:null:1", "Other:2:3"]);
  });

  it("files tracks straight in an artist folder as Singles, and root-level tracks under their tagged artist or Unknown Artist", async () => {
    const m = await newLibrary();
    await m.add("Solo", ["Loose.mp3"]);
    await m.add("", ["Rootless.mp3", "Tagged.mp3"]);
    const [tagged] = await db.select().from(titles).where(and(eq(titles.libraryId, m.lib.id), eq(titles.name, "Tagged")));
    await db.update(titles).set({ authors: ["Someone"] }).where(eq(titles.id, tagged.id));
    await organizeMusicLibrary(m.lib.id);
    expect((await m.view()).albums).toEqual(["Solo / Singles", "Someone / Singles", "Unknown Artist / Singles"]);
  });

  it("treats spellings that differ only in case or spacing as one artist and one album", async () => {
    const m = await newLibrary();
    await m.add("The Beatles/Abbey Road", ["01 - Come Together.mp3"]);
    await m.add("the  beatles/abbey road", ["02 - Something.mp3"]);
    await organizeMusicLibrary(m.lib.id);
    const v = await m.view();
    expect(v.artists).toEqual(["The Beatles"]);
    expect(v.albums).toEqual(["The Beatles / Abbey Road"]);
    expect(v.raw.artists[0].sortKey).toBe("beatles");
  });

  it("moves a track whose file moved to another folder, and removes the album and artist it leaves empty", async () => {
    const m = await newLibrary();
    await m.add("Old/Album", ["01 - Song.mp3"]);
    await organizeMusicLibrary(m.lib.id);
    const [t] = (await m.view()).raw.tracks;
    await db.update(titles).set({ folderPath: "New/Record" }).where(eq(titles.id, t.id));
    await organizeMusicLibrary(m.lib.id);
    const v = await m.view();
    expect(v.artists).toEqual(["New"]);
    expect(v.albums).toEqual(["New / Record"]);
    expect(v.raw.tracks[0].albumId).toBe(v.raw.albums[0].id);
  });

  it("gives an album the earliest year in its tracks' tags and keeps it current", async () => {
    const m = await newLibrary();
    await m.add("A/B", ["01 - x.mp3", "02 - y.mp3", "03 - z.mp3"]);
    const rows = (await m.view()).raw.tracks.sort((a, b) => a.name.localeCompare(b.name));
    await db.update(titles).set({ year: 1999 }).where(eq(titles.id, rows[0].id));
    await db.update(titles).set({ year: 1990 }).where(eq(titles.id, rows[1].id));
    await organizeMusicLibrary(m.lib.id);
    expect((await m.view()).raw.albums[0].year).toBe(1990);
    await db.update(titles).set({ year: null }).where(eq(titles.id, rows[1].id));
    await organizeMusicLibrary(m.lib.id);
    expect((await m.view()).raw.albums[0].year).toBe(1999);
  });

  it("keeps libraries apart, even with the same artist and album names", async () => {
    const a = await newLibrary();
    const b = await newLibrary();
    await a.add("X/Y", ["01 - s.mp3"]);
    await b.add("X/Y", ["01 - s.mp3"]);
    await organizeMusicLibrary(a.lib.id);
    await organizeMusicLibrary(b.lib.id);
    const [va, vb] = [await a.view(), await b.view()];
    expect(va.raw.albums[0].id).not.toBe(vb.raw.albums[0].id);
    expect(va.raw.tracks[0].albumId).toBe(va.raw.albums[0].id);
  });

  it("handles more tracks than fit one chunk", async () => {
    const m = await newLibrary();
    const names = Array.from({ length: 1100 }, (_, i) => `${String(i + 1).padStart(4, "0")} - Song ${i + 1}.mp3`);
    await m.add("Big/Album", names);
    expect(await organizeMusicLibrary(m.lib.id)).toEqual({ placed: 1100, complete: true });
    const v = await m.view();
    expect(v.albums).toEqual(["Big / Album"]);
    expect(v.raw.tracks.every((t) => t.albumId === v.raw.albums[0].id)).toBe(true);
  }, 60_000);

  it("stops when its time is up, reports it, and a later run finishes the job", async () => {
    const m = await newLibrary();
    await m.add("A/B", Array.from({ length: 700 }, (_, i) => `${String(i + 1).padStart(3, "0")} - s${i}.mp3`));
    const early = await organizeMusicLibrary(m.lib.id, Date.now() - 1);
    expect(early).toEqual({ placed: 0, complete: false });
    expect((await m.view()).albums).toEqual([]);
    expect(await organizeMusicLibrary(m.lib.id)).toEqual({ placed: 700, complete: true });
  });

  it("two passes at once end with one artist and one album, and a sweep running beside them takes nothing that has tracks", async () => {
    const m = await newLibrary();
    await m.add("Solo/Record", ["01 - a.mp3", "02 - b.mp3"]);
    await Promise.all([organizeMusicLibrary(m.lib.id), organizeMusicLibrary(m.lib.id), sweepEmptyMusicGroups(m.lib.id)]);
    await organizeMusicLibrary(m.lib.id);
    const v = await m.view();
    expect(v.artists).toEqual(["Solo"]);
    expect(v.albums).toEqual(["Solo / Record"]);
    expect(v.raw.tracks.every((t) => t.albumId === v.raw.albums[0].id)).toBe(true);
  });

  it("sweeps only empty albums and artists, and only in the library asked", async () => {
    const a = await newLibrary();
    const b = await newLibrary();
    await a.add("A/One", ["01 - s.mp3"]);
    await a.add("A/Two", ["01 - s.mp3"]);
    await b.add("A/One", ["01 - s.mp3"]);
    await organizeMusicLibrary(a.lib.id);
    await organizeMusicLibrary(b.lib.id);
    const gone = (await a.view()).raw.tracks.find((t) => t.folderPath === "A/Two")!;
    await db.delete(titles).where(eq(titles.id, gone.id));
    await db.delete(titles).where(eq(titles.libraryId, b.lib.id));
    await sweepEmptyMusicGroups(a.lib.id);
    expect((await a.view()).albums).toEqual(["A / One"]);
    expect((await b.view()).albums).toEqual(["A / One"]); // b's empty album is not a's business
    await sweepEmptyMusicGroups(b.lib.id);
    expect(await b.view().then((v) => v.artists)).toEqual([]);
  });
});

describe("in a scan", () => {
  it("probing a music library groups its tracks, and an audio library is left alone", async () => {
    const m = await newLibrary();
    await m.add("A/B", ["01 - x.mp3"]);
    await db.update(mediaFiles).set({ probeStatus: "ok", durationSeconds: 60 });
    const provider = { listFolder: async () => [], getFolder: async () => null, getStreamingUrl: async () => ({ url: "", expiresAt: new Date() }), fetchByteRange: async () => new ArrayBuffer(0) } satisfies StorageProvider;
    await probeVideoLibrary(provider, m.lib.id, Date.now() + 60_000, [], MUSIC_PROFILE);
    expect((await m.view()).albums).toEqual(["A / B"]);

    const admin = await makeAccount(db, "plain");
    const server = await makeServer(db, admin.accountId);
    const audio = await makeLibrary(db, server.id, "audio", "everyone");
    await syncVideoDirectory(audio.id, "p", "A/B", [{ id: `aud-only-${n}`, name: "01 - x.mp3", kind: "file", sizeBytes: 10 }], null, (await import("@/lib/scan/tree-profile")).AUDIO_PROFILE);
    await db.update(mediaFiles).set({ probeStatus: "ok", durationSeconds: 60 });
    await probeVideoLibrary(provider, audio.id, Date.now() + 60_000, [], (await import("@/lib/scan/tree-profile")).AUDIO_PROFILE);
    expect(await db.select().from(musicAlbums).where(eq(musicAlbums.libraryId, audio.id))).toEqual([]);
    expect((await db.select().from(titles).where(eq(titles.libraryId, audio.id)))[0].name).toBe("01 - x"); // audio keeps the file name as it is
  });

  it("pruning songs that left Box also removes the albums and artists they leave empty, but not the ones that still have songs", async () => {
    pruneSettings.graceMs = 0;
    const m = await newLibrary();
    const cycle = crypto.randomUUID();
    await db.update(libraries).set({ scanCycleId: cycle, scanCycleClean: true, pruneMissing: true }).where(eq(libraries.id, m.lib.id));
    await syncVideoDirectory(m.lib.id, "p", "Gone/Album", [{ id: `pg-${n}-1`, name: "01 - a.mp3", kind: "file", sizeBytes: 10 }], cycle, MUSIC_PROFILE);
    await syncVideoDirectory(m.lib.id, "p", "Kept/Album", [{ id: `pg-${n}-2`, name: "01 - b.mp3", kind: "file", sizeBytes: 10 }], cycle, MUSIC_PROFILE);
    await organizeMusicLibrary(m.lib.id);
    await db.update(titles).set({ lastSeenCycle: crypto.randomUUID() }).where(eq(titles.boxFolderId, `file:pg-${n}-1`));
    const res = await pruneMissingVideos({ fileExists: async (id: string) => id !== `pg-${n}-1` }, m.lib.id, cycle, Date.now() + 60_000, MUSIC_PROFILE);
    expect(res.removed).toBe(1);
    const v = await m.view();
    expect(v.artists).toEqual(["Kept"]);
    expect(v.albums).toEqual(["Kept / Album"]);
  });
});
