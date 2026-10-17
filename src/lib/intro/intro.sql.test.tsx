/** Times found from sound: which seasons are offered, what is kept, and where they sit among hand marks and SkipDB's. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/storage/box", () => ({
  createBoxProviderForServer: () => ({ getStreamingUrl: async (id: string) => ({ url: `https://orig/${id}`, expiresAt: new Date(Date.now() + 60_000) }) }),
}));

import { eq } from "drizzle-orm";
import { episodes, mediaFiles, seasons } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { buildPlayManifest } from "@/lib/player/manifest";
import { SkipButton } from "@/components/player/skip-button";
import { activeSkipButton } from "@/lib/skipdb/active";
import { resetSkipdbMemory } from "@/lib/skipdb/client";
import { saveDetected, seasonsToDetect } from "./queue";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let skipdb: "none" | "intro" = "none";
beforeEach(() => {
  skipdb = "none";
  resetSkipdbMemory();
  delete process.env.SKIPDB_URL;
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ segments: { intro: skipdb === "intro" ? { start_ms: 61_000, end_ms: 91_000, confidence: 0.8 } : null, outro: null, recap: null, preview: null } }), { status: 200 }));
});
afterEach(() => vi.unstubAllGlobals());

let n = 0;
async function season(count: number, over: { imdbId?: string | null; show?: string; sizes?: number[] } = {}) {
  const owner = await makeAccount(db, `ro${++n}`);
  const server = await makeServer(db, owner.accountId);
  const lib = await makeLibrary(db, server.id, "shows", "everyone");
  const show = await makeTitle(db, lib.id, { kind: "show", name: over.show ?? `Show ${n}`, boxFolderId: `file:k${n}`, imdbId: over.imdbId ?? null });
  const [sn] = await db.insert(seasons).values({ titleId: show.id, number: 1, boxFolderId: `sk${n}` }).returning();
  const eps: { id: string; fileId: string }[] = [];
  for (let i = 1; i <= count; i++) {
    const [ep] = await db.insert(episodes).values({ seasonId: sn.id, number: i, boxFolderId: `ep${n}-${i}` }).returning();
    const [f] = await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: ep.id, partIndex: 0, boxFileId: `rb${n}-${i}`, filename: `e${i}.mp4`, sizeBytes: 1000, container: "mp4", probeStatus: "ok", durationSeconds: 2700 }).returning();
    eps.push({ id: ep.id, fileId: f.boxFileId });
  }
  return { owner, server, show, eps };
}

describe("which seasons are offered", () => {
  it("offers a season with its ordinary, fully read episodes, and not once every one is done (unless forced)", async () => {
    const s = await season(4, { show: "Offered Show" });
    const offered = () => seasonsToDetect(db, { show: "offered show" });
    expect((await offered()).map((x) => [x.showName, x.season, x.episodes.length])).toEqual([["Offered Show", 1, 4]]);
    for (const e of s.eps.slice(0, 3)) await saveDetected(db, e.id, []);
    expect(await offered()).toHaveLength(1); // one episode is still to do
    await saveDetected(db, s.eps[3].id, []);
    expect(await offered()).toEqual([]);
    expect(await seasonsToDetect(db, { show: "offered show", force: true })).toHaveLength(1);
    expect(await seasonsToDetect(db, { show: "offered show", season: 2, force: true })).toEqual([]);
  });

  it("leaves out an episode with several parts, no length, an unsupported container or a copy of another file", async () => {
    const s = await season(5, { show: "Picky Show" });
    await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: s.eps[0].id, partIndex: 1, boxFileId: "part2", filename: "e1b.mp4", container: "mp4", durationSeconds: 100 }).onConflictDoNothing();
    await db.update(mediaFiles).set({ durationSeconds: null }).where(eq(mediaFiles.boxFileId, s.eps[1].fileId));
    await db.update(mediaFiles).set({ container: "mkv" }).where(eq(mediaFiles.boxFileId, s.eps[2].fileId));
    const [offered] = await seasonsToDetect(db, { show: "picky show" });
    expect(offered.episodes.map((e) => e.number).sort()).toEqual([4, 5]);
  });
});

describe("keeping what was found", () => {
  it("is kept on every version of the episode, as nothing when nothing was found, and replaced next time", async () => {
    const s = await season(3);
    await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: s.eps[0].id, partIndex: 0, versionLabel: "720p", boxFileId: "v720", filename: "e1 - 720p.mp4", container: "mp4", durationSeconds: 2700 });
    const at = new Date("2026-02-01T00:00:00Z");
    await saveDetected(db, s.eps[0].id, [{ kind: "intro", startSeconds: 62, endSeconds: 92 }], at);
    const rows = await db.select().from(mediaFiles).where(eq(mediaFiles.ownerId, s.eps[0].id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.detectedSkipMarks?.[0]?.startSeconds === 62 && r.skipDetectedAt?.getTime() === at.getTime())).toBe(true);
    await saveDetected(db, s.eps[0].id, []);
    const after = await db.select().from(mediaFiles).where(eq(mediaFiles.ownerId, s.eps[0].id));
    expect(after.every((r) => r.detectedSkipMarks === null && r.skipDetectedAt !== null)).toBe(true);
    const other = await db.select().from(mediaFiles).where(eq(mediaFiles.ownerId, s.eps[1].id));
    expect(other[0].skipDetectedAt).toBeNull();
  });
});

describe("in the play manifest", () => {
  const marks = [{ kind: "intro" as const, startSeconds: 62, endSeconds: 92 }, { kind: "outro" as const, startSeconds: 2600, endSeconds: 2700 }];

  it("carries the times found from sound, marked as such, when nothing else has them", async () => {
    const s = await season(3);
    await saveDetected(db, s.eps[1].id, marks);
    const r = await buildPlayManifest("episode", s.eps[1].id, s.owner.viewer.id, s.server.id);
    expect(r.ok && r.manifest.skipSegments).toEqual([{ ...marks[0], source: "detected" }, { ...marks[1], source: "detected" }]);
    const none = await buildPlayManifest("episode", s.eps[0].id, s.owner.viewer.id, s.server.id);
    expect(none.ok && none.manifest.skipSegments).toBeUndefined();
  });

  it("gives way to SkipDB's time for the same kind, and to a time marked by hand, one kind at a time", async () => {
    const s = await season(3, { imdbId: "tt0000777" });
    await saveDetected(db, s.eps[1].id, marks);
    skipdb = "intro";
    const withSkipdb = await buildPlayManifest("episode", s.eps[1].id, s.owner.viewer.id, s.server.id);
    expect(withSkipdb.ok && withSkipdb.manifest.skipSegments).toEqual([{ kind: "intro", startSeconds: 61, endSeconds: 91 }, { ...marks[1], source: "detected" }]);
    await db.update(mediaFiles).set({ skipMarks: [{ kind: "intro", startSeconds: 70, endSeconds: 100 }] }).where(eq(mediaFiles.ownerId, s.eps[1].id));
    const withOwn = await buildPlayManifest("episode", s.eps[1].id, s.owner.viewer.id, s.server.id);
    expect(withOwn.ok && withOwn.manifest.skipSegments).toEqual([{ kind: "intro", startSeconds: 70, endSeconds: 100, source: "own" }, { ...marks[1], source: "detected" }]);
  });

  it("is not credited to SkipDB on the button, which still skips and goes to the next episode", () => {
    const detected = [{ ...marks[0], source: "detected" as const }, { ...marks[1], source: "detected" as const }];
    const intro = activeSkipButton(detected, 70, 2700, true);
    expect(intro).toMatchObject({ kind: "intro", action: "seek", toSeconds: 92, fromSkipdb: false });
    expect(activeSkipButton(detected, 2650, 2700, true)).toMatchObject({ kind: "outro", action: "next", fromSkipdb: false });
    expect(activeSkipButton([{ ...marks[0], source: undefined }], 70, 2700, true)?.fromSkipdb).toBe(true);
    expect(renderToStaticMarkup(<SkipButton state={intro!} onSeek={() => undefined} />)).not.toContain("SkipDB");
  });
});
