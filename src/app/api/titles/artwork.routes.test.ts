/** GET /api/titles/[id]/artwork: who may see a title's picture, and how it is cached. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  resolution: null as unknown,
  withinLimit: true,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => h.withinLimit }));

import { artworkImages, libraryMembers, profiles, titles, viewers } from "@/lib/db/schema";
import { artworkOf, joinServer, makeAccount, makeLibrary, makeServer, makeTitle, makeViewer, putArtwork, type TestDb } from "@/lib/playlists/test-db";
import { TEST_JPEG } from "@/lib/scan/test-mp4";
import { GET } from "./[id]/artwork/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
beforeEach(() => {
  h.resolution = null;
  h.withinLimit = true;
});

const get = (id: string, headers: Record<string, string> = {}) =>
  GET(new Request("http://x/api/titles/x/artwork", { headers }), { params: Promise.resolve({ id }) } as never);

async function signInAs(accountId: string, viewerId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all.find((v) => v.id === viewerId), viewers: all };
}

async function world(access: "everyone" | "restricted" = "everyone", kind: "video" | "audio" = "video") {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const library = await makeLibrary(db, server.id, kind, access);
  // An audio file is stored as an audiobook title; a video file as a movie.
  const title = await makeTitle(db, library.id, { kind: kind === "audio" ? "audiobook" : "movie", boxFolderId: `file:${Math.random()}`, ratingAges: { ANY: 0 } });
  await putArtwork(db, title.id, TEST_JPEG);
  return { admin, server, member, library, title };
}

describe("artwork route", () => {
  it("serves the image to a member, privately cached, typed, and not sniffable", async () => {
    const w = await world();
    await signInAs(w.member.accountId, w.member.viewer.id);
    const res = await get(w.title.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300, must-revalidate");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(TEST_JPEG);
  });

  it("answers 304 to a matching ETag, still with the private headers", async () => {
    const w = await world();
    await signInAs(w.member.accountId, w.member.viewer.id);
    const first = await get(w.title.id);
    const etag = first.headers.get("etag")!;
    const again = await get(w.title.id, { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(again.headers.get("cache-control")).toContain("private");
    expect((await get(w.title.id, { "if-none-match": '"other"' })).status).toBe(200);
  });

  it("is the same 404 for everything that isn't allowed: signed out, malformed, unknown, not a member, no picture", async () => {
    const w = await world();
    const outsider = await makeAccount(db, "outsider");
    const bare = await makeTitle(db, w.library.id, { boxFolderId: `file:${Math.random()}` });

    const results: Response[] = [];
    h.resolution = null;
    results.push(await get(w.title.id)); // signed out
    await signInAs(w.member.accountId, w.member.viewer.id);
    results.push(await get("not-a-uuid"));
    results.push(await get("00000000-0000-4000-8000-0000000000aa"));
    results.push(await get(bare.id)); // visible title, but no picture
    await signInAs(outsider.accountId, outsider.viewer.id);
    results.push(await get(w.title.id)); // not on this server
    for (const r of results) expect(r.status).toBe(404);
    const bodies = await Promise.all(results.map((r) => r.json()));
    for (const b of bodies) expect(b).toEqual({ error: "Not found" });
  });

  it("hides a restricted library's pictures from an ungranted account, and shows them to a granted one and the admin", async () => {
    const w = await world("restricted");
    await signInAs(w.member.accountId, w.member.viewer.id);
    expect((await get(w.title.id)).status).toBe(404);
    await db.insert(libraryMembers).values({ libraryId: w.library.id, serverId: w.server.id, accountId: w.member.accountId });
    expect((await get(w.title.id)).status).toBe(200);
    await db.delete(libraryMembers).where(eq(libraryMembers.libraryId, w.library.id));
    expect((await get(w.title.id)).status).toBe(404); // revoked: immediately gone
    await signInAs(w.admin.accountId, w.admin.viewer.id);
    expect((await get(w.title.id)).status).toBe(200);
  });

  it("applies the profile's age limit: a kid profile can't fetch an adult title's picture", async () => {
    const w = await world();
    await db.update(titles).set({ ratingAges: { ANY: 17 } }).where(eq(titles.id, w.title.id));
    const kid = await makeViewer(db, w.member.accountId, { name: "kid", role: "limited", maxAge: 7, allowUnrated: false });
    await signInAs(w.member.accountId, kid.id);
    expect((await get(w.title.id)).status).toBe(404);
    await signInAs(w.member.accountId, w.member.viewer.id); // the account's unrestricted owner profile
    expect((await get(w.title.id)).status).toBe(200);
  });

  it("refuses to serve anything that isn't a JPEG or PNG, even if it got into the table", async () => {
    const w = await world();
    // Pictures are shared by their bytes, and every world here uses the same ones: change this image, then put it back.
    const hash = (await artworkOf(db, w.title.id))!.hash;
    await db.update(artworkImages).set({ contentType: "text/html" }).where(eq(artworkImages.hash, hash));
    try {
      await signInAs(w.member.accountId, w.member.viewer.id);
      expect((await get(w.title.id)).status).toBe(404);
    } finally {
      await db.update(artworkImages).set({ contentType: "image/jpeg" }).where(eq(artworkImages.hash, hash));
    }
  });

  it("serves an audio file's cover under the same rules: members and the admin yes, an ungranted account no, a revoked grant no", async () => {
    const w = await world("restricted", "audio");
    await signInAs(w.member.accountId, w.member.viewer.id);
    expect((await get(w.title.id)).status).toBe(404);
    await db.insert(libraryMembers).values({ libraryId: w.library.id, serverId: w.server.id, accountId: w.member.accountId });
    const ok = await get(w.title.id);
    expect(ok.status, "granted member").toBe(200);
    expect(ok.headers.get("cache-control")).toContain("private");
    await db.delete(libraryMembers).where(eq(libraryMembers.libraryId, w.library.id));
    expect((await get(w.title.id)).status).toBe(404);
    await signInAs(w.admin.accountId, w.admin.viewer.id);
    expect((await get(w.title.id)).status, "admin").toBe(200);
  });

  it("is rate limited", async () => {
    const w = await world();
    await signInAs(w.member.accountId, w.member.viewer.id);
    h.withinLimit = false;
    expect((await get(w.title.id)).status).toBe(429);
  });
});
