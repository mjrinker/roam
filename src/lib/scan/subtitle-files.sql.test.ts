/** Subtitle files beside videos become sound-only mutes for the words they say. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { mediaFiles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import type { StorageEntry } from "@/lib/storage/provider";
import { matchSubtitleFiles, subtitleFileParts, syncSubtitleFiles } from "./subtitle-files";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const entry = (id: string, name: string, extra: Partial<StorageEntry> = {}): StorageEntry => ({ id, name, kind: "file", sizeBytes: 10_000, ...extra });
const SRT = "1\n00:00:10,000 --> 00:00:12,000\nWhat the hell was that?\n\n2\n00:00:20,000 --> 00:00:22,000\nA perfectly nice line.\n";
const provider = (files: Record<string, string>) => ({ fetchByteRange: async (id: string, s: number, e: number) => new TextEncoder().encode(files[id].slice(s, e + 1)).buffer as ArrayBuffer });

let n = 0;
async function film() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const t = await makeTitle(db, lib.id, { kind: "movie", boxFolderId: `file:s${++n}` });
  const boxFileId = `sbox${n}`;
  await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, partIndex: 0, boxFileId, filename: "Movie (2020).mp4", sizeBytes: 1000, container: "mp4", probeStatus: "ok", durationSeconds: 100 });
  return boxFileId;
}
const rowOf = async (boxFileId: string) => (await db.select().from(mediaFiles).where(eq(mediaFiles.boxFileId, boxFileId)))[0];

describe("subtitle file names", () => {
  it("reads a language tag and a forced marker", () => {
    expect(subtitleFileParts("Movie (2020).srt")).toEqual({ base: "Movie (2020)", language: null, forced: false });
    expect(subtitleFileParts("Movie (2020).en.srt")).toMatchObject({ base: "Movie (2020)", language: "en" });
    expect(subtitleFileParts("Movie.eng.sdh.srt")).toMatchObject({ base: "Movie", language: "eng" });
    expect(subtitleFileParts("Movie.en.forced.srt")?.forced).toBe(true);
    expect(subtitleFileParts("Movie.mp4")).toBeNull();
  });
  it("matches English or untagged files to their video, preferring a tagged English one, never forced or other languages", () => {
    const m = matchSubtitleFiles([entry("v", "Movie (2020).mp4"), entry("a", "Movie (2020).srt"), entry("b", "Movie (2020).en.srt"), entry("c", "Movie (2020).es.srt"), entry("d", "Movie (2020).en.forced.srt"), entry("v2", "Other.mp4"), entry("e", "Other.fr.srt")]);
    expect(m.find((x) => x.file.id === "v")?.subtitle?.id).toBe("b");
    expect(m.find((x) => x.file.id === "v2")?.subtitle).toBeNull();
  });
});

describe("building mutes from a subtitle file", () => {
  it("stores sound-only language mutes (no text), once, and again only when the file changes", async () => {
    const id = await film();
    const listing = [entry(id, "Movie (2020).mp4"), entry("sub", "Movie (2020).srt", { modifiedAt: new Date(Date.now() - 60_000) })];
    await syncSubtitleFiles(provider({ sub: SRT }), listing);
    const row = await rowOf(id);
    expect(row.languageSource).toBe("srt");
    expect(row.languageBuiltAt).not.toBeNull();
    expect(row.languageCues).toHaveLength(1);
    expect(row.languageCues![0]).toMatchObject({ category: "language", channel: "sound", severity: "low" });
    expect(row.languageCues![0].startSeconds).toBeGreaterThan(9);
    expect(JSON.stringify(row.languageCues)).not.toMatch(/hell|nice/i);
    // Unchanged since it was built: not read again.
    const spy = vi.fn(async () => new ArrayBuffer(0));
    await syncSubtitleFiles({ fetchByteRange: spy }, listing);
    expect(spy).not.toHaveBeenCalled();
  });
  it("removes the mutes when the subtitle file goes, but not ones that came from somewhere else", async () => {
    const id = await film();
    await syncSubtitleFiles(provider({ sub: SRT }), [entry(id, "Movie (2020).mp4"), entry("sub", "Movie (2020).srt")]);
    await syncSubtitleFiles(provider({}), [entry(id, "Movie (2020).mp4")]);
    expect(await rowOf(id)).toMatchObject({ languageCues: null, languageSource: null });
    await db.update(mediaFiles).set({ languageCues: [{ startSeconds: 1, endSeconds: 2, category: "language", severity: "low", channel: "sound" }], languageSource: "opensubtitles", languageBuiltAt: new Date() }).where(eq(mediaFiles.boxFileId, id));
    await syncSubtitleFiles(provider({}), [entry(id, "Movie (2020).mp4")]);
    expect((await rowOf(id)).languageSource).toBe("opensubtitles");
  });
  it("records that a subtitle was read even when it has nothing to mute, keeps what it had when unreadable, and never throws", async () => {
    const id = await film();
    await syncSubtitleFiles(provider({ sub: "1\n00:00:01,000 --> 00:00:02,000\nAll clean here.\n" }), [entry(id, "Movie (2020).mp4"), entry("sub", "Movie (2020).srt")]);
    expect(await rowOf(id)).toMatchObject({ languageCues: null, languageSource: "srt" });
    const failing = { fetchByteRange: async () => { throw new Error("network"); } };
    await expect(syncSubtitleFiles(failing, [entry(id, "Movie (2020).mp4"), entry("sub", "Movie (2020).srt")])).resolves.toBeUndefined();
  });
});
