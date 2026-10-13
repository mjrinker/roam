/** Chapters end to end through the database: chapter files beside videos, what a re-read leaves alone, and the play manifest's chapters. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  embedded: null as { title: string; startSeconds: number }[] | null,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/storage/box", () => ({
  createBoxProviderForServer: () => ({
    getStreamingUrl: async (id: string) => ({ url: `https://orig/${id}`, expiresAt: new Date(Date.now() + 60_000) }),
  }),
}));
vi.mock("@/lib/scan/mp4-duration", async (orig) => ({
  ...(await orig<typeof import("@/lib/scan/mp4-duration")>()),
  probeMp4: async () => ({ durationSeconds: 100, chapters: h.embedded, chaptersSource: "qt", audioCodec: null, videoCodec: null, codecsProbed: true }),
}));

import { mediaFiles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { buildPlayManifest } from "@/lib/player/manifest";
import { readChaptersForPending, pendingChapterReadCondition } from "@/lib/scan/media-files";
import { matchChapterFiles, syncChapterFiles } from "@/lib/scan/chapter-files";
import type { StorageEntry } from "@/lib/storage/provider";
import { chaptersFromRows } from "./rows";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let n = 0;
async function movie(parts: { durationSeconds: number; chapters?: { title: string; startSeconds: number }[] | null }[]) {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const t = await makeTitle(db, lib.id, { kind: "movie", boxFolderId: `file:c${++n}` });
  const ids: string[] = [];
  for (const [i, p] of parts.entries()) {
    ids.push(`cbox${n}-${i}`);
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, partIndex: i, boxFileId: ids[i], filename: `Movie - pt${i + 1}.mp4`, sizeBytes: 1000, container: "mp4", probeStatus: "ok", durationSeconds: p.durationSeconds, chapters: p.chapters ?? null });
  }
  return { t, server, owner, ids };
}
const entry = (id: string, name: string, sizeBytes = 100): StorageEntry => ({ id, name, kind: "file", sizeBytes });
const textProvider = (files: Record<string, string>) => ({
  fetchByteRange: async (id: string, start: number, end: number) => new TextEncoder().encode(files[id].slice(start, end + 1)).buffer as ArrayBuffer,
});
const rowOf = async (boxFileId: string) => (await db.select().from(mediaFiles).where(eq(mediaFiles.boxFileId, boxFileId)))[0];

describe("matching chapter files to videos", () => {
  it("matches on the video's name without its extension, ignoring case, and prefers XML", () => {
    const m = matchChapterFiles([entry("v1", "The Matrix (1999).mp4"), entry("c1", "the matrix (1999).chapters.txt"), entry("c2", "The Matrix (1999).chapters.xml"), entry("v2", "Other.mp4"), entry("c3", "Unrelated.chapters.xml"), entry("x", "Matrix-trailer.mp4")]);
    expect(m.find((x) => x.file.id === "v1")?.chapterFile?.id).toBe("c2");
    expect(m.find((x) => x.file.id === "v2")?.chapterFile).toBeNull();
    expect(m.some((x) => x.file.id === "x")).toBe(false); // an extra is not a film
  });
});

describe("chapter files in the database", () => {
  it("stores a chapter file's chapters on the video, and they outrank the video's own on a re-read", async () => {
    const { ids } = await movie([{ durationSeconds: 100, chapters: [{ title: "Chapter 1", startSeconds: 0 }, { title: "Chapter 2", startSeconds: 50 }] }]);
    const listing = [entry(ids[0], "Movie - pt1.mp4"), entry("side1", "Movie - pt1.chapters.txt")];
    await syncChapterFiles(textProvider({ side1: "0:00 Cold open\n0:30 The job" }), listing);
    expect(await rowOf(ids[0])).toMatchObject({ chaptersSource: "file", chapters: [{ title: "Cold open", startSeconds: 0 }, { title: "The job", startSeconds: 30 }] });
    // The video's own chapters are read again (a re-probe, or the backfill): the chapter file's stay.
    h.embedded = [{ title: "Chapter 1", startSeconds: 0 }, { title: "Chapter 2", startSeconds: 99 }];
    await readChaptersForPending(textProvider({}) as never, [await rowOf(ids[0])], Date.now() + 5000);
    expect((await rowOf(ids[0])).chapters?.[0].title).toBe("Cold open");
  });

  it("hands the video back to its own chapters once the chapter file is gone", async () => {
    const { ids } = await movie([{ durationSeconds: 100 }]);
    await syncChapterFiles(textProvider({ s: "0:00 A\n1:00 B" }), [entry(ids[0], "Movie - pt1.mp4"), entry("s", "Movie - pt1.chapters.txt")]);
    expect((await rowOf(ids[0])).chaptersSource).toBe("file");
    await syncChapterFiles(textProvider({}), [entry(ids[0], "Movie - pt1.mp4")]);
    expect(await rowOf(ids[0])).toMatchObject({ chapters: null, chaptersSource: null, chaptersReadAt: null });
  });

  it("ignores an empty or unreadable chapter file and keeps what the video had", async () => {
    const { ids } = await movie([{ durationSeconds: 100, chapters: [{ title: "Keep", startSeconds: 0 }] }]);
    await syncChapterFiles(textProvider({ s: "nothing useful here" }), [entry(ids[0], "Movie - pt1.mp4"), entry("s", "Movie - pt1.chapters.txt")]);
    expect((await rowOf(ids[0])).chapters?.[0].title).toBe("Keep");
    const failing = { fetchByteRange: async () => { throw new Error("network"); } };
    await expect(syncChapterFiles(failing, [entry(ids[0], "Movie - pt1.mp4"), entry("s", "Movie - pt1.chapters.txt")])).resolves.toBeUndefined();
  });
});

describe("the chapter backfill", () => {
  it("reads a probed video's own chapters once, and records that it did", async () => {
    const { ids } = await movie([{ durationSeconds: 100 }]);
    h.embedded = [{ title: "Chapter 1", startSeconds: 0 }, { title: "Chapter 2", startSeconds: 40 }];
    const pending = (await db.select().from(mediaFiles).where(pendingChapterReadCondition)).filter((r) => r.boxFileId === ids[0]);
    expect(pending).toHaveLength(1);
    await readChaptersForPending(textProvider({}) as never, pending, Date.now() + 5000);
    expect(await rowOf(ids[0])).toMatchObject({ chaptersSource: "embedded", chapters: h.embedded });
    expect((await db.select().from(mediaFiles).where(pendingChapterReadCondition)).some((r) => r.boxFileId === ids[0])).toBe(false);
  });
});

describe("the play manifest's chapters", () => {
  it("puts each part's chapters on one clock and marks no part boundary of its own", async () => {
    const c = await movie([
      { durationSeconds: 3000, chapters: [{ title: "Chapter 1", startSeconds: 0 }, { title: "Chapter 2", startSeconds: 1500 }] },
      { durationSeconds: 3000, chapters: [{ title: "Chapter 1", startSeconds: 0 }, { title: "Chapter 2", startSeconds: 1000 }] },
    ]);
    const r = await buildPlayManifest("title", c.t.id, c.owner.viewer.id, c.server.id);
    expect(r.ok && r.manifest.chapters).toEqual([
      { title: "Chapter 1", startSeconds: 0 },
      { title: "Chapter 2", startSeconds: 1500 },
      { title: "Chapter 3", startSeconds: 3000 },
      { title: "Chapter 4", startSeconds: 4000 },
    ]);
  });

  it("has no chapters for a film with none, or with only one", async () => {
    const none = await movie([{ durationSeconds: 100 }]);
    const one = await movie([{ durationSeconds: 100, chapters: [{ title: "Chapter 1", startSeconds: 0 }] }]);
    for (const c of [none, one]) {
      const r = await buildPlayManifest("title", c.t.id, c.owner.viewer.id, c.server.id);
      expect(r.ok && r.manifest.chapters).toEqual([]);
    }
  });
});

describe("chaptersFromRows (the details page)", () => {
  it("uses the same clock as the player, and waits for every part's length", () => {
    const row = (partIndex: number, durationSeconds: number | null, chapters: { title: string; startSeconds: number }[]) => ({ partIndex, durationSeconds, trimStartSeconds: null, trimDurationSeconds: null, chapters });
    expect(chaptersFromRows([row(1, 100, [{ title: "B1", startSeconds: 10 }]), row(0, 100, [{ title: "A1", startSeconds: 0 }, { title: "A2", startSeconds: 50 }])]).map((c) => [c.title, c.startSeconds])).toEqual([["A1", 0], ["A2", 50], ["B1", 110]]);
    expect(chaptersFromRows([row(0, null, [{ title: "A1", startSeconds: 0 }, { title: "A2", startSeconds: 50 }])])).toEqual([]);
  });
});
