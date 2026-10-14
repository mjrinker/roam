/** Skip times in the play manifest, and the skip button's markup. */
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

import { episodes, mediaFiles, seasons } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { buildPlayManifest } from "@/lib/player/manifest";
import { SkipButton } from "@/components/player/skip-button";
import { resetSkipdbMemory } from "./client";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let asked: string[] = [];
let answer: "ok" | "down" = "ok";
beforeEach(() => {
  asked = [];
  answer = "ok";
  resetSkipdbMemory();
  delete process.env.SKIPDB_URL;
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    if (answer === "down") throw new Error("offline");
    return new Response(JSON.stringify({ segments: { intro: { start_ms: 61_000, end_ms: 91_000, confidence: 0.8 }, outro: { start_ms: 2500_000, end_ms: 2640_000, confidence: 0.8 }, recap: null, preview: null } }), { status: 200 });
  });
});
afterEach(() => vi.unstubAllGlobals());

let n = 0;
async function episode(imdbId: string | null) {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const lib = await makeLibrary(db, server.id, "shows", "everyone");
  const show = await makeTitle(db, lib.id, { kind: "show", boxFolderId: `file:k${++n}`, imdbId });
  const [season] = await db.insert(seasons).values({ titleId: show.id, number: 2, boxFolderId: `sk${n}` }).returning();
  const [ep] = await db.insert(episodes).values({ seasonId: season.id, number: 5, boxFolderId: `sk${n}` }).returning();
  await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: ep.id, partIndex: 0, boxFileId: `skbox${n}`, filename: "e.mp4", sizeBytes: 1000, container: "mp4", probeStatus: "ok", durationSeconds: 2700 });
  return { ep, server, owner };
}

describe("skip times in the play manifest", () => {
  it("carries intro and credits times for an episode, asked by the show's IMDb id, season, episode and the episode's length", async () => {
    const c = await episode("tt0903747");
    const r = await buildPlayManifest("episode", c.ep.id, c.owner.viewer.id, c.server.id);
    expect(r.ok && r.manifest.skipSegments).toEqual([{ kind: "intro", startSeconds: 61, endSeconds: 91 }, { kind: "outro", startSeconds: 2500, endSeconds: 2640 }]);
    const url = new URL(asked.find((a) => a.includes("skipdb"))!);
    expect(Object.fromEntries(url.searchParams)).toEqual({ imdb_id: "tt0903747", duration: "2700", season: "2", episode: "5" });
  });
  it("has none, and doesn't ask, without an IMDb id or when switched off, and still plays when they can't be reached", async () => {
    const none = await episode(null);
    const a = await buildPlayManifest("episode", none.ep.id, none.owner.viewer.id, none.server.id);
    expect(a.ok && a.manifest.skipSegments).toBeUndefined();
    expect(asked).toEqual([]);
    process.env.SKIPDB_URL = "off";
    const off = await episode("tt0000042");
    expect((await buildPlayManifest("episode", off.ep.id, off.owner.viewer.id, off.server.id)).ok).toBe(true);
    expect(asked).toEqual([]);
    delete process.env.SKIPDB_URL;
    answer = "down";
    const down = await episode("tt0000043");
    const d = await buildPlayManifest("episode", down.ep.id, down.owner.viewer.id, down.server.id);
    expect(d.ok && d.manifest.skipSegments).toBeUndefined();
  });
});

describe("SkipButton", () => {
  it("skips to the end of a segment, with SkipDB's credit", () => {
    const html = renderToStaticMarkup(<SkipButton state={{ action: "seek", label: "Skip intro", toSeconds: 91, fromSkipdb: true }} onSeek={() => undefined} />);
    expect(html).toContain("Skip intro");
    expect(html).toContain("Skip times from SkipDB");
    expect(html).toContain('href="https://skipdb.tv"');
  });
  it("goes to the next episode by a link, and credits no one when its own timing is behind it", () => {
    const html = renderToStaticMarkup(<SkipButton state={{ action: "next", label: "Next episode", fromSkipdb: false }} nextHref="/s/1/watch/episode/9" onSeek={() => undefined} />);
    expect(html).toContain('href="/s/1/watch/episode/9"');
    expect(html).not.toContain("SkipDB");
  });
});
