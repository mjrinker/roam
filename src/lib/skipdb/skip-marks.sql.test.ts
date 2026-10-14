/** Hand-marked skip times through the database, and how they combine with SkipDB's in the play manifest. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/storage/box", () => ({
  createBoxProviderForServer: () => ({ getStreamingUrl: async (id: string) => ({ url: `https://orig/${id}`, expiresAt: new Date(Date.now() + 60_000) }) }),
}));

import { episodes, mediaFiles, seasons, viewers } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { buildPlayManifest } from "@/lib/player/manifest";
import { resetSkipdbMemory } from "./client";
import { loadSkipMarks, saveSkipMarks } from "./save-skip-marks";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
let asked: string[] = [];
beforeEach(() => {
  asked = [];
  resetSkipdbMemory();
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify({ segments: { intro: { start_ms: 100_000, end_ms: 130_000, confidence: 0.9 }, outro: { start_ms: 2500_000, end_ms: 2640_000, confidence: 0.9 } } }), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

let n = 0;
async function episode(autoSkip: object = {}) {
  const owner = await makeAccount(db, "o");
  await db.update(viewers).set({ autoSkip }).where(eq(viewers.id, owner.viewer.id));
  const server = await makeServer(db, owner.accountId);
  const lib = await makeLibrary(db, server.id, "shows", "everyone");
  const show = await makeTitle(db, lib.id, { kind: "show", boxFolderId: `file:sm${++n}`, imdbId: `tt${String(n).padStart(7, "1")}` });
  const [season] = await db.insert(seasons).values({ titleId: show.id, number: 1, boxFolderId: `sm${n}` }).returning();
  const [ep] = await db.insert(episodes).values({ seasonId: season.id, number: 3, boxFolderId: `sm${n}` }).returning();
  const [file] = await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: ep.id, partIndex: 0, boxFileId: `smbox${n}`, filename: "e.mp4", sizeBytes: 1000, container: "mp4", probeStatus: "ok", durationSeconds: 2700 }).returning();
  return { ep, server, owner, file };
}
const play = (c: Awaited<ReturnType<typeof episode>>) => buildPlayManifest("episode", c.ep.id, c.owner.viewer.id, c.server.id);

describe("saving and loading", () => {
  it("keeps the marks on the file and reads them back, replacing and deleting", async () => {
    const c = await episode();
    const saved = await saveSkipMarks(db, { ownerKind: "episode", ownerId: c.ep.id, version: "", marks: [{ kind: "intro", startSeconds: 30, endSeconds: 60 }, { kind: "bogus", startSeconds: 1, endSeconds: 50 }] });
    expect(saved?.marks).toEqual([{ kind: "intro", startSeconds: 30, endSeconds: 60 }]);
    expect((await db.select().from(mediaFiles).where(eq(mediaFiles.id, c.file.id)))[0].skipMarks).toEqual([{ kind: "intro", startSeconds: 30, endSeconds: 60 }]);
    expect((await loadSkipMarks(db, "episode", c.ep.id, ""))?.marks).toHaveLength(1);
    await saveSkipMarks(db, { ownerKind: "episode", ownerId: c.ep.id, version: "", marks: [] });
    expect((await db.select().from(mediaFiles).where(eq(mediaFiles.id, c.file.id)))[0].skipMarks).toBeNull();
  });
  it("is not ready until the length is known", async () => {
    const c = await episode();
    await db.update(mediaFiles).set({ durationSeconds: null }).where(eq(mediaFiles.id, c.file.id));
    expect(await loadSkipMarks(db, "episode", c.ep.id, "")).toBeNull();
    expect(await saveSkipMarks(db, { ownerKind: "episode", ownerId: c.ep.id, version: "", marks: [] })).toBeNull();
  });
});

describe("in the play manifest", () => {
  it("uses a hand-marked time over SkipDB's for that kind only, flagged as own", async () => {
    const c = await episode();
    await saveSkipMarks(db, { ownerKind: "episode", ownerId: c.ep.id, version: "", marks: [{ kind: "intro", startSeconds: 40, endSeconds: 70 }] });
    const r = await play(c);
    expect(r.ok && r.manifest.skipSegments).toEqual([
      { kind: "intro", startSeconds: 40, endSeconds: 70, source: "own" },
      { kind: "outro", startSeconds: 2500, endSeconds: 2640 },
    ]);
  });
  it("doesn't ask SkipDB at all once every kind is marked by hand", async () => {
    const c = await episode();
    await saveSkipMarks(db, { ownerKind: "episode", ownerId: c.ep.id, version: "", marks: [{ kind: "intro", startSeconds: 40, endSeconds: 70 }, { kind: "recap", startSeconds: 0, endSeconds: 30 }, { kind: "outro", startSeconds: 2500, endSeconds: 2600 }, { kind: "preview", startSeconds: 2600, endSeconds: 2650 }] });
    const r = await play(c);
    expect(r.ok && r.manifest.skipSegments).toHaveLength(4);
    expect(asked.filter((a) => a.includes("skipdb"))).toEqual([]);
  });
  it("carries the profile's auto-skip choices, only when it made any", async () => {
    const some = await episode({ intro: true, outro: true });
    const a = await play(some);
    expect(a.ok && a.manifest.autoSkip).toEqual({ intro: true, outro: true });
    const none = await episode();
    const b = await play(none);
    expect(b.ok && b.manifest.autoSkip).toBeUndefined();
  });
});
