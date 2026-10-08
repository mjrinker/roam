/** GET /api/ebooks/[id]/file and /url: books only, behind library access and the age limit, one 404 for every refusal, and a fresh Box address each time. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  resolution: null as unknown,
  boxCalls: [] as string[],
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
vi.mock("@/lib/storage/box", () => ({
  createBoxProviderForServer: () => ({ getStreamingUrl: async (fileId: string) => (h.boxCalls.push(fileId), { url: `https://dl.box.example/${fileId}?token=abc`, expiresAt: new Date() }) }),
}));

import { libraryMembers, mediaFiles, profiles, viewers } from "@/lib/db/schema";
import { joinServer, putArtwork, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { GET } from "./[id]/file/route";
import { GET as getUrl } from "./[id]/url/route";
import { GET as artwork } from "../titles/[id]/artwork/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
beforeEach(() => {
  h.boxCalls.length = 0;
});

async function signInAs(accountId: string, viewerId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all.find((v) => v.id === viewerId), viewers: all };
}
const get = (id: string) => GET(new Request("http://x"), { params: Promise.resolve({ id }) } as never);

async function world(access: "everyone" | "restricted" = "everyone", ratingAges: Record<string, number> | null = null) {
  const owner = await makeAccount(db, "owner");
  const server = await makeServer(db, owner.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const lib = await makeLibrary(db, server.id, "ebooks", access);
  const book = await makeTitle(db, lib.id, { kind: "ebook", name: "A Book", boxFolderId: `file:${Math.random()}`, ratingAges });
  await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: book.id, partIndex: 0, boxFileId: "box-file-1", filename: "a.epub", probeStatus: "ok" });
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "Film" });
  await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: film.id, partIndex: 0, boxFileId: "film-file", filename: "f.mp4", probeStatus: "ok" });
  await signInAs(member.accountId, member.viewer.id);
  return { owner, server, member, lib, book, film };
}

describe("GET /api/ebooks/[id]/file", () => {
  it("sends a member to a short-lived Box address, with no caching", async () => {
    const w = await world();
    const res = await get(w.book.id);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://dl.box.example/box-file-1?token=abc");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is the same 404 for a malformed id, an unknown id, a title that isn't a book, and someone not signed in", async () => {
    const w = await world();
    const missing = "00000000-0000-4000-8000-0000000000aa";
    const outcomes = [await get("nope"), await get(missing), await get(w.film.id)].map((r) => r.status);
    expect(outcomes).toEqual([404, 404, 404]);
    h.resolution = null;
    expect((await get(w.book.id)).status).toBe(404);
    expect(h.boxCalls).toEqual([]);
  });

  it("hides a restricted library from an account that wasn't given it, and shows it once granted", async () => {
    const w = await world("restricted");
    expect((await get(w.book.id)).status).toBe(404);
    await db.insert(libraryMembers).values({ libraryId: w.lib.id, serverId: w.server.id, accountId: w.member.accountId });
    expect((await get(w.book.id)).status).toBe(302);
    expect(h.boxCalls).toEqual(["box-file-1"]);
  });

  it("applies the profile's age limit", async () => {
    const w = await world("everyone", { ANY: 18 });
    await db.update(viewers).set({ maxAge: 7 }).where(eq(viewers.id, w.member.viewer.id));
    await signInAs(w.member.accountId, w.member.viewer.id);
    expect((await get(w.book.id)).status).toBe(404);
    expect(h.boxCalls).toEqual([]);
  });

  it("does not reach another server's books", async () => {
    const [one, two] = [await world(), await world()];
    await signInAs(two.member.accountId, two.member.viewer.id);
    expect((await get(one.book.id)).status).toBe(404);
  });

  it("serves a book's cover through the artwork route, behind the same gate", async () => {
    const w = await world("restricted");
    await putArtwork(db, w.book.id, [1, 2, 3, 4]);
    const art = () => artwork(new Request("http://x"), { params: Promise.resolve({ id: w.book.id }) } as never);
    expect((await art()).status).toBe(404); // not granted
    await db.insert(libraryMembers).values({ libraryId: w.lib.id, serverId: w.server.id, accountId: w.member.accountId });
    const res = await art();
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
  });

  it("the JSON address for the in-browser reader follows the same rules: a member gets the address, nobody else learns anything", async () => {
    const w = await world("restricted");
    const ask = (id: string) => getUrl(new Request("http://x"), { params: Promise.resolve({ id }) } as never);
    expect((await ask(w.book.id)).status).toBe(404); // not granted
    expect((await ask(w.film.id)).status).toBe(404); // not a book
    expect((await ask("nope")).status).toBe(404);
    await db.insert(libraryMembers).values({ libraryId: w.lib.id, serverId: w.server.id, accountId: w.member.accountId });
    const res = await ask(w.book.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ url: "https://dl.box.example/box-file-1?token=abc" });
  });
});
