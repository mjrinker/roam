/** Content filtering through the database: .mcf files beside videos, and what the play manifest asks each viewer's player to skip. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
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

import { mediaFiles, viewers } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { buildPlayManifest } from "@/lib/player/manifest";
import { matchFilterFiles, syncContentFilterFiles } from "@/lib/scan/content-filter-files";
import type { StorageEntry } from "@/lib/storage/provider";
import type { FilterCue } from "./categories";
import { cuesFromRows } from "./rows";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let n = 0;
async function movie(parts: { durationSeconds: number; cues?: FilterCue[] | null }[]) {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const t = await makeTitle(db, lib.id, { kind: "movie", boxFolderId: `file:f${++n}` });
  const ids: string[] = [];
  for (const [i, p] of parts.entries()) {
    ids.push(`fbox${n}-${i}`);
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, partIndex: i, boxFileId: ids[i], filename: `Movie - pt${i + 1}.mp4`, sizeBytes: 1000, container: "mp4", probeStatus: "ok", durationSeconds: p.durationSeconds, contentCues: p.cues ?? null });
  }
  return { t, server, owner, ids };
}
const cue = (startSeconds: number, endSeconds: number, category: FilterCue["category"], severity: FilterCue["severity"] = "high", channel: FilterCue["channel"] = "both"): FilterCue => ({ startSeconds, endSeconds, category, severity, channel });
const entry = (id: string, name: string, sizeBytes = 100_000): StorageEntry => ({ id, name, kind: "file", sizeBytes });
const textProvider = (files: Record<string, string>) => ({ fetchByteRange: async (id: string, s: number, e: number) => new TextEncoder().encode(files[id].slice(s, e + 1)).buffer as ArrayBuffer });
const rowOf = async (boxFileId: string) => (await db.select().from(mediaFiles).where(eq(mediaFiles.boxFileId, boxFileId)))[0];
const MCF = "WEBVTT MovieContentFilter 1.1.0\n\n00:00:10.000 --> 00:00:20.000\nviolence=high\n\n00:00:30.000 --> 00:00:31.000\nlanguage=medium=audio\n";

describe("matching .mcf files to videos", () => {
  it("matches on the video's name without its extension, ignoring case, and not extras", () => {
    const m = matchFilterFiles([entry("v1", "The Matrix (1999).mp4"), entry("c1", "the matrix (1999).mcf"), entry("v2", "Other.mp4"), entry("c2", "Unrelated.mcf"), entry("x", "Matrix-trailer.mp4")]);
    expect(m.find((x) => x.file.id === "v1")?.filterFile?.id).toBe("c1");
    expect(m.find((x) => x.file.id === "v2")?.filterFile).toBeNull();
    expect(m.some((x) => x.file.id === "x")).toBe(false);
  });
});

describe(".mcf files in the database", () => {
  it("stores a file's cues on the video, and removes them when the file goes", async () => {
    const { ids } = await movie([{ durationSeconds: 100 }]);
    const listing = [entry(ids[0], "Movie - pt1.mp4"), entry("mcf1", "Movie - pt1.mcf")];
    await syncContentFilterFiles(textProvider({ mcf1: MCF }), listing);
    expect((await rowOf(ids[0])).contentCues).toEqual([cue(10, 20, "violence"), cue(30, 31, "language", "medium", "sound")]);
    await syncContentFilterFiles(textProvider({}), [entry(ids[0], "Movie - pt1.mp4")]);
    expect((await rowOf(ids[0])).contentCues).toBeNull();
  });
  it("keeps what the video had when the file is unreadable, and never throws", async () => {
    const { ids } = await movie([{ durationSeconds: 100, cues: [cue(1, 2, "fear")] }]);
    await syncContentFilterFiles(textProvider({ s: "rubbish" }), [entry(ids[0], "Movie - pt1.mp4"), entry("s", "Movie - pt1.mcf")]);
    expect((await rowOf(ids[0])).contentCues).toEqual([cue(1, 2, "fear")]);
    const failing = { fetchByteRange: async () => { throw new Error("network"); } };
    await expect(syncContentFilterFiles(failing, [entry(ids[0], "Movie - pt1.mp4"), entry("s", "Movie - pt1.mcf")])).resolves.toBeUndefined();
  });
});

describe("what the play manifest asks each viewer's player to skip", () => {
  const setPrefs = (viewerId: string, prefs: object) => db.update(viewers).set({ contentFilter: prefs }).where(eq(viewers.id, viewerId));

  it("is nothing for a profile that chose nothing, and the chosen scenes for one that did", async () => {
    const c = await movie([{ durationSeconds: 100, cues: [cue(10, 20, "violence"), cue(30, 31, "language", "medium", "sound"), cue(50, 60, "nudity", "low")] }]);
    const none = await buildPlayManifest("title", c.t.id, c.owner.viewer.id, c.server.id);
    expect(none.ok && none.manifest.skips).toEqual([]);
    await setPrefs(c.owner.viewer.id, { violence: "high", language: "low" });
    const some = await buildPlayManifest("title", c.t.id, c.owner.viewer.id, c.server.id);
    expect(some.ok && some.manifest.skips).toEqual([
      { startSeconds: 10, endSeconds: 20, action: "skip", categories: ["violence"] },
      { startSeconds: 30, endSeconds: 31, action: "mute", categories: ["language"] },
    ]);
  });

  it("puts each part's cues on one clock", async () => {
    const c = await movie([{ durationSeconds: 100, cues: [cue(10, 20, "violence")] }, { durationSeconds: 100, cues: [cue(5, 15, "violence")] }]);
    await setPrefs(c.owner.viewer.id, { violence: "low" });
    const r = await buildPlayManifest("title", c.t.id, c.owner.viewer.id, c.server.id);
    expect(r.ok && r.manifest.skips?.map((s) => [s.startSeconds, s.endSeconds])).toEqual([[10, 20], [105, 115]]);
  });

  it("adds the choices made just before playing to the profile's own, for that play only", async () => {
    const c = await movie([{ durationSeconds: 100, cues: [cue(10, 20, "violence"), cue(30, 40, "nudity"), cue(50, 60, "language", "low")] }]);
    await setPrefs(c.owner.viewer.id, { violence: "high" });
    const base = await buildPlayManifest("title", c.t.id, c.owner.viewer.id, c.server.id);
    expect(base.ok && base.manifest.skips?.map((s) => s.startSeconds)).toEqual([10]);
    const extra = await buildPlayManifest("title", c.t.id, c.owner.viewer.id, c.server.id, [], false, { extraSkip: { nudity: "high", language: "low" } });
    expect(extra.ok && extra.manifest.skips?.map((s) => s.startSeconds)).toEqual([10, 30, 50]);
    // A weaker pick cannot undo the profile's own choice, and nothing was saved: the next play is back to the profile's.
    const weaker = await buildPlayManifest("title", c.t.id, c.owner.viewer.id, c.server.id, [], false, { extraSkip: { violence: "high" } });
    expect(weaker.ok && weaker.manifest.skips?.map((s) => s.startSeconds)).toEqual([10]);
    const after = await buildPlayManifest("title", c.t.id, c.owner.viewer.id, c.server.id);
    expect(after.ok && after.manifest.skips?.map((s) => s.startSeconds)).toEqual([10]);
  });

  it("ignores a stored choice that is not a real category or strength", async () => {
    const c = await movie([{ durationSeconds: 100, cues: [cue(10, 20, "violence")] }]);
    await setPrefs(c.owner.viewer.id, { sparkles: "high", violence: "huge" });
    const r = await buildPlayManifest("title", c.t.id, c.owner.viewer.id, c.server.id);
    expect(r.ok && r.manifest.skips).toEqual([]);
  });
});

describe("cuesFromRows (the details page)", () => {
  it("uses the same clock as the player, and waits for every part's length", () => {
    const row = (partIndex: number, durationSeconds: number | null, contentCues: FilterCue[]) => ({ partIndex, durationSeconds, trimStartSeconds: null, trimDurationSeconds: null, contentCues });
    expect(cuesFromRows([row(1, 100, [cue(5, 10, "sex")]), row(0, 100, [cue(1, 2, "fear")])]).map((c) => [c.category, c.startSeconds])).toEqual([["fear", 1], ["sex", 105]]);
    expect(cuesFromRows([row(0, null, [cue(1, 2, "fear")])])).toEqual([]);
  });
});
