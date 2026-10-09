/** Resolution versions of one movie or episode ("- 1080p", "- 4K"): kept apart, each with its own parts, on a real in-memory Postgres. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { mediaFiles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import type { StorageEntry } from "@/lib/storage/provider";
import { groupByVersion, orderMediaSegments } from "./conventions";
import { resolveEpisodeSplits } from "./episode-split-pass";
import { rollupTitleRuntime, upsertMediaSegments } from "./media-files";
import { titles } from "@/lib/db/schema";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const entry = (id: string, name: string): StorageEntry => ({ id, name, kind: "file", sizeBytes: 1000 }) as StorageEntry;
/** What the scanner does with a folder's files: each version's parts in order, versions side by side. */
const ordered = (files: StorageEntry[]) => [...groupByVersion(files).values()].flatMap((g) => orderMediaSegments(g));
const rowsOf = (kind: "title" | "episode", id: string) =>
  db.select().from(mediaFiles).where(and(eq(mediaFiles.ownerKind, kind), eq(mediaFiles.ownerId, id))).orderBy(asc(mediaFiles.versionLabel), asc(mediaFiles.partIndex));
const summary = (rows: Awaited<ReturnType<typeof rowsOf>>) => rows.map((r) => `${r.versionLabel || "-"}:${r.partIndex}:${r.boxFileId}`);

async function movie() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  return { lib, film: await makeTitle(db, lib.id, { kind: "movie" }) };
}

describe("a movie saved in several resolutions", () => {
  it("keeps each version's files as its own parts, every version starting at part 0", async () => {
    const { film } = await movie();
    await upsertMediaSegments("title", film.id, ordered([entry("a", "M (2020) - 1080p.mp4"), entry("b", "M (2020) - 4K - pt2.mp4"), entry("c", "M (2020) - 4K - pt1.mp4"), entry("d", "M (2020).mp4")]));
    expect(summary(await rowsOf("title", film.id))).toEqual(["-:0:d", "1080p:0:a", "4k:0:c", "4k:1:b"]);
  });
  it("is stable across rescans and when a version's parts swap order", async () => {
    const { film } = await movie();
    const files = [entry("a", "M - 1080p.mp4"), entry("b", "M - 4K - pt1.mp4"), entry("c", "M - 4K - pt2.mp4")];
    await upsertMediaSegments("title", film.id, ordered(files));
    await upsertMediaSegments("title", film.id, ordered(files));
    await upsertMediaSegments("title", film.id, ordered([files[0], entry("b", "M - 4K - pt2.mp4"), entry("c", "M - 4K - pt1.mp4")]));
    expect(summary(await rowsOf("title", film.id))).toEqual(["1080p:0:a", "4k:0:c", "4k:1:b"]);
  });
  it("drops only the version whose file left, and a renamed file moves between versions", async () => {
    const { film } = await movie();
    await upsertMediaSegments("title", film.id, ordered([entry("a", "M - 1080p.mp4"), entry("b", "M - 4K.mp4")]));
    await upsertMediaSegments("title", film.id, ordered([entry("a", "M - 1080p.mp4")]));
    expect(summary(await rowsOf("title", film.id))).toEqual(["1080p:0:a"]);
    await upsertMediaSegments("title", film.id, ordered([entry("a", "M - 720p.mp4")]));
    const rows = await rowsOf("title", film.id);
    expect(summary(rows)).toEqual(["720p:0:a"]);
    expect(rows[0].filename).toBe("M - 720p.mp4");
  });
});

describe("an episode saved in several resolutions", () => {
  it("leaves each version's files alone in the multi-episode split pass", async () => {
    const owner = await makeAccount(db, "o2");
    const server = await makeServer(db, owner.accountId);
    const lib = await makeLibrary(db, server.id, "shows", "everyone");
    const { episodes } = await makeShow(db, lib.id, 2, { name: "Show" });
    await upsertMediaSegments("episode", episodes[0].id, ordered([entry("e1a", "Show - s01e01 - 1080p.mp4"), entry("e1b", "Show - s01e01 - 720p.mp4")]));
    await resolveEpisodeSplits([episodes[0].id]);
    const rows = await rowsOf("episode", episodes[0].id);
    expect(summary(rows)).toEqual(["1080p:0:e1a", "720p:0:e1b"]);
    expect(rows.every((r) => r.trimSource === null && r.trimDurationSeconds === null)).toBe(true);
  });
});

describe("a movie's runtime with several versions", () => {
  it("is one version's length, not the sum, and is not held up by a version that isn't probed", async () => {
    const { film } = await movie();
    await upsertMediaSegments("title", film.id, ordered([entry("a", "M - 1080p.mp4"), entry("b", "M - 4K - pt1.mp4"), entry("c", "M - 4K - pt2.mp4")]));
    const rows = await rowsOf("title", film.id);
    for (const r of rows) {
      const big = r.versionLabel === "4k";
      await db.update(mediaFiles).set({ durationSeconds: big ? 3000 : 6000, width: big ? 3840 : 1920, height: big ? 2160 : 1080 }).where(eq(mediaFiles.id, r.id));
    }
    await rollupTitleRuntime(film.id);
    expect((await db.select().from(titles).where(eq(titles.id, film.id)))[0].runtimeSeconds).toBe(6000); // the 4K parts together
  });
});
