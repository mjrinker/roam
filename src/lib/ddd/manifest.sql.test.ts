/** The play manifest with Does the Dog Die: what a profile's choices skip from the community's scenes, and the notice when they can't be had. */
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

import { dddItems, mediaFiles, platformJobs, servers, viewers } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { buildPlayManifest } from "@/lib/player/manifest";
import { resetClientMemory } from "./client";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let n = 0;
let ddd: "ok" | "down" = "ok";
beforeEach(async () => {
  process.env.DDD_API_KEY = "test-key";
  ddd = "ok";
  resetClientMemory();
  await db.delete(dddItems);
  await db.delete(platformJobs);
  vi.stubGlobal("fetch", async (url: string) => {
    if (ddd === "down") return new Response("{}", { status: 500 });
    const path = url.replace("https://www.doesthedogdie.com/api/v3", "");
    const headers = { "x-ratelimit-limit-month": "5000", "x-ratelimit-remaining-month": "4000" };
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers });
    if (path.startsWith("/items?")) return json([{ id: 10, name: "Old Yeller", itemTypeName: "Movie" }]);
    if (path === "/topics") return json([{ id: 153, name: "a dog dies" }, { id: 7, name: "there are jump scares" }]);
    if (path === "/items/10/ratings") return json([{ yes: 1, topicId: 153, index1: -1, index2: -1, position1: 0, position2: 1, position3: 40, safePosition1: 0, safePosition2: 2, safePosition3: 0 }]);
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DDD_API_KEY;
});

async function film(access: "disabled" | "limited" | "full", prefs: object) {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  await db.update(servers).set({ dddAccess: access }).where(eq(servers.id, server.id));
  await db.update(viewers).set({ contentFilter: prefs }).where(eq(viewers.id, owner.viewer.id));
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const t = await makeTitle(db, lib.id, { kind: "movie", boxFolderId: `file:d${++n}`, imdbId: `tt${String(n).padStart(7, "0")}` });
  await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, partIndex: 0, boxFileId: `dbox${n}`, filename: "Movie.mp4", sizeBytes: 1000, container: "mp4", probeStatus: "ok", durationSeconds: 7200 });
  return { t, server, owner };
}
const play = (c: Awaited<ReturnType<typeof film>>) => buildPlayManifest("title", c.t.id, c.owner.viewer.id, c.server.id);

describe("community scenes in the play manifest", () => {
  it("skips a reported scene the profile chose, widened a little, and says nothing", async () => {
    const r = await play(await film("full", { animals: "high" }));
    expect(r.ok && r.manifest.skips).toEqual([{ startSeconds: 98, endSeconds: 121, action: "skip", categories: ["animals"] }]);
    expect(r.ok && r.manifest.notice).toBeUndefined();
  });
  it("works at the limited level too (a play is when it asks), and not at all when disabled", async () => {
    const limited = await play(await film("limited", { animals: "low" }));
    expect(limited.ok && limited.manifest.skips).toHaveLength(1);
    const off = await play(await film("disabled", { animals: "low" }));
    expect(off.ok && off.manifest.skips).toEqual([]);
  });
  it("ignores categories the profile didn't choose, and never asks at all when it chose nothing", async () => {
    const other = await play(await film("full", { sex: "low" }));
    expect(other.ok && other.manifest.skips).toEqual([]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await play(await film("full", {}));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("plays without filtering and says so, once, when they can't be reached", async () => {
    ddd = "down";
    const r = await play(await film("full", { animals: "low" }));
    expect(r.ok && r.manifest.skips).toEqual([]);
    expect(r.ok && r.manifest.notice).toMatch(/playing without it/);
  });
  it("says nothing when the title simply isn't in their database", async () => {
    vi.stubGlobal("fetch", async () => new Response("[]", { status: 200, headers: { "x-ratelimit-limit-month": "5000", "x-ratelimit-remaining-month": "4000" } }));
    const r = await play(await film("full", { animals: "low" }));
    expect(r.ok && r.manifest.notice).toBeUndefined();
  });
});
