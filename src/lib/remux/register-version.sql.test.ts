/** Adding uploaded versions to Roam's records straight away, on a real in-memory Postgres (probing is stubbed). */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, isNotNull } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, probeErrors: [] as string[] }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/scan/media-files", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/scan/media-files")>();
  return {
    ...original,
    // The real probe reads the MP4 over Box; here it just marks the rows as read, the way it would.
    probeFiles: vi.fn(async (_p: unknown, files: { id: string }[], _d: number, errors: string[]) => {
      const { mediaFiles } = await import("@/lib/db/schema");
      const { inArray } = await import("drizzle-orm");
      errors.push(...h.probeErrors);
      await h.testDb.db.update(mediaFiles).set({ probeStatus: "ok", durationSeconds: 100, durationMs: 100_000, width: 1280, height: 534, audioCodec: "ac-3", videoCodec: "avc1", codecProbed: true }).where(inArray(mediaFiles.id, files.map((f) => f.id)));
      return false;
    }),
  };
});

import { mediaFiles, titles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { registerAacCopy, registerVersion } from "./register-version";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
const provider = {} as never;

async function movie() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, lib.id, { kind: "movie" });
  await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: film.id, partIndex: 0, boxFileId: "orig", filename: "M (2020).mp4", sizeBytes: 9, container: "mp4", probeStatus: "ok", durationSeconds: 100, durationMs: 100_000, width: 1920, height: 1080 });
  return film;
}
const rowsOf = (id: string) => db.select().from(mediaFiles).where(and(eq(mediaFiles.ownerId, id), eq(mediaFiles.ownerKind, "title"))).orderBy(asc(mediaFiles.versionLabel));

describe("registering an uploaded version", () => {
  it("adds it next to the original with its label, probes it, and sets the runtime from the best version", async () => {
    const film = await movie();
    const ids = await registerVersion(provider, [{ kind: "title", id: film.id }], "M (2020) - 720p.mp4", { id: "v720", size: 5 });
    expect(ids).toHaveLength(1);
    const rows = await rowsOf(film.id);
    expect(rows.map((r) => [r.versionLabel, r.boxFileId, r.partIndex])).toEqual([["", "orig", 0], ["720p", "v720", 0]]);
    expect(rows[1]).toMatchObject({ filename: "M (2020) - 720p.mp4", probeStatus: "ok", width: 1280, height: 534 });
    expect((await db.select().from(titles).where(eq(titles.id, film.id)))[0].runtimeSeconds).toBe(100);
  });
  it("is the same again when repeated, and adds one row per episode a combined file plays for", async () => {
    const film = await movie();
    await registerVersion(provider, [{ kind: "title", id: film.id }], "M - 480p.mp4", { id: "v480", size: 5 });
    await registerVersion(provider, [{ kind: "title", id: film.id }], "M - 480p.mp4", { id: "v480", size: 6 });
    expect((await rowsOf(film.id)).filter((r) => r.versionLabel === "480p")).toHaveLength(1);
    const owner = await makeAccount(db, "o2");
    const server = await makeServer(db, owner.accountId);
    const lib = await makeLibrary(db, server.id, "shows", "everyone");
    const { episodes } = await makeShow(db, lib.id, 2, { name: "S" });
    const ids = await registerVersion(provider, episodes.map((e) => ({ kind: "episode" as const, id: e.id })), "S - S01E01-E02 - 720p.mp4", { id: "combo", size: 5 });
    expect(ids).toHaveLength(2);
  });
  it("reports a failure instead of throwing, and a read problem as a warning", async () => {
    const warnings: string[] = [];
    const nothing = await registerVersion(provider, [{ kind: "title", id: "not-a-uuid" }], "x - 720p.mp4", { id: "z", size: 1 }, (m) => warnings.push(m));
    expect(nothing).toEqual([]);
    expect(warnings[0]).toContain("a rescan will pick it up");
    const film = await movie();
    h.probeErrors = ["probe x: boom"];
    const warned: string[] = [];
    await registerVersion(provider, [{ kind: "title", id: film.id }], "M - 360p.mp4", { id: "v360", size: 5 }, (m) => warned.push(m));
    h.probeErrors = [];
    expect(warned[0]).toContain("a rescan will retry");
  });
});

describe("registering an AAC copy", () => {
  it("links it to the version's rows and probes it", async () => {
    const film = await movie();
    const ids = await registerVersion(provider, [{ kind: "title", id: film.id }], "M - 720p.mp4", { id: "v720b", size: 5 });
    await registerAacCopy(provider, ids, "M - 720p.aac.mp4", { id: "v720b-aac", size: 3 });
    const variants = await db.select().from(mediaFiles).where(and(eq(mediaFiles.boxFileId, "v720b-aac"), isNotNull(mediaFiles.variantOfMediaFileId)));
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({ variantOfMediaFileId: ids[0], filename: "M - 720p.aac.mp4", probeStatus: "ok" });
  });
  it("does nothing without a version to link to", async () => {
    await expect(registerAacCopy(provider, [], "x.aac.mp4", { id: "n", size: 1 })).resolves.toBeUndefined();
  });
});
