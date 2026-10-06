/** The timeline API behind the page's infinite scroll: same rules as the page, uniform 404s, exact paging. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  resolution: null as unknown,
  limited: false,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => !h.limited }));

import { profiles, titles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { GET } from "./[id]/photos/route";
import { GET as getMonths } from "./[id]/photos/months/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const get = (id: string, query = "") => GET(new Request(`http://x/api/libraries/${id}/photos${query}`), ctx(id));
async function signInAs(accountId: string, over: Partial<typeof viewers.$inferSelect> = {}) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: { ...all[0], ...over }, viewers: all };
}

let n = 0;
async function world(count = 5) {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const member = await makeAccount(db, "m");
  await joinServer(db, server.id, member.accountId);
  const lib = await makeLibrary(db, server.id, "photos", "everyone");
  const made = [];
  for (let i = 0; i < count; i++) made.push(await makeTitle(db, lib.id, { kind: "photo", boxFolderId: `file:tl${++n}`, takenAt: new Date(Date.UTC(2024, 0, 1 + i)), takenAtSource: "box" }));
  await signInAs(member.accountId);
  return { owner, server, member, lib, made };
}

describe("GET /api/libraries/[id]/photos", () => {
  it("pages through the whole timeline with the cursor it returns, newest first, privately", async () => {
    const w = await world(130);
    const seen: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 5; guard++) {
      const res = await get(w.lib.id, after ? `?after=${after}` : "");
      expect(res.status).toBe(200);
      expect([res.headers.get("cache-control"), res.headers.get("vary")]).toEqual(["private, no-store", "Cookie"]);
      const body = (await res.json()) as { items: { id: string }[]; next: string | null };
      seen.push(...body.items.map((i) => i.id));
      after = body.next;
      if (!after) break;
    }
    expect(seen).toHaveLength(130);
    expect(new Set(seen).size).toBe(130);
    expect(seen[0]).toBe(w.made[129].id); // the newest
    expect(seen[129]).toBe(w.made[0].id);
  });

  it("is the same 404 for a bad id, a missing library, a non-member, a signed-out visitor, a hidden library and a library that isn't for photos", async () => {
    const w = await world(2);
    const video = await makeLibrary(db, w.server.id, "video", "everyone");
    const restricted = await makeLibrary(db, w.server.id, "photos", "restricted");
    const outcome = async (id: string) => {
      const r = await get(id);
      return `${r.status} ${r.headers.get("cache-control")} ${JSON.stringify(await r.json())}`;
    };
    const missing = "00000000-0000-4000-8000-0000000000ee";
    const seen = [await outcome("nope"), await outcome(missing), await outcome(video.id), await outcome(restricted.id)];
    h.resolution = null;
    seen.push(await outcome(w.lib.id));
    await signInAs((await makeAccount(db, "stranger")).accountId);
    seen.push(await outcome(w.lib.id));
    expect(new Set(seen).size, seen.join(" | ")).toBe(1);
    expect(seen[0].startsWith("404")).toBe(true);
  });

  it("applies the viewer's age limit, rejects a malformed cursor, and limits the rate with an uncached 429", async () => {
    const w = await world(3);
    await db.update(titles).set({ ratingAges: { ANY: 8 } as never }).where(eq(titles.libraryId, w.lib.id));
    await db.update(titles).set({ ratingAges: { ANY: 18 } as never }).where(eq(titles.id, w.made[2].id));
    await signInAs(w.member.accountId, { maxAge: 12, allowUnrated: false } as never);
    const ids = ((await (await get(w.lib.id)).json()).items as { id: string }[]).map((i) => i.id);
    expect(ids).not.toContain(w.made[2].id);
    expect(ids).toHaveLength(2);
    for (const bad of ["?after=%%%", "?after=bm90LWpzb24", `?after=${Buffer.from(JSON.stringify({ t: "x", id: "y" })).toString("base64url")}`, `?after=${Buffer.from(JSON.stringify({ t: 1e300, id: "11111111-1111-4111-8111-111111111111" })).toString("base64url")}`, `?after=${Buffer.from(JSON.stringify({ t: 253402300800, id: "11111111-1111-4111-8111-111111111111" })).toString("base64url")}`]) {
      expect((await get(w.lib.id, bad)).status, bad).toBe(400);
    }
    h.limited = true;
    const limited = await get(w.lib.id);
    expect([limited.status, limited.headers.get("cache-control")]).toEqual([429, "private, no-store"]);
    h.limited = false;
  });

  it("serves a restricted library to a member who was granted it", async () => {
    const w = await world(1);
    const restricted = await makeLibrary(db, w.server.id, "photos", "restricted");
    await makeTitle(db, restricted.id, { kind: "photo", boxFolderId: `file:rs${++n}`, takenAt: new Date("2024-01-01T00:00:00Z") });
    expect((await get(restricted.id)).status).toBe(404);
    const { libraryMembers } = await import("@/lib/db/schema");
    await db.insert(libraryMembers).values({ libraryId: restricted.id, accountId: w.member.accountId, serverId: w.server.id });
    expect((await get(restricted.id)).status).toBe(200);
  });
});

describe("loading one block, through the API", () => {
  it("returns only that block's photos in pages of 500, accepts a level, and rejects a bad level or a long key", async () => {
    const w = await world(0);
    for (let i = 0; i < 3; i++) await makeTitle(db, w.lib.id, { kind: "photo", name: `mar ${i}`, boxFolderId: `file:b${++n}`, takenAt: new Date(Date.UTC(2024, 2, 10 + i)), takenAtSource: "box" });
    await makeTitle(db, w.lib.id, { kind: "photo", name: "apr", boxFolderId: `file:b${++n}`, takenAt: new Date(Date.UTC(2024, 3, 1)), takenAtSource: "box" });
    const names = async (query: string) => ((await (await get(w.lib.id, query)).json()).items as { name: string }[]).map((i) => i.name);
    expect(await names("?bucket=2024-03")).toEqual(["mar 2", "mar 1", "mar 0"]);
    expect(await names("?bucket=2024-03-11&level=day")).toEqual(["mar 1"]);
    expect(await names("?bucket=2024&level=year")).toEqual(["apr", "mar 2", "mar 1", "mar 0"]);
    expect(await names("?bucket=2024-13")).toEqual([]);
    for (const bad of ["?bucket=2024-03&level=week", `?bucket=${"x".repeat(13)}`]) expect((await get(w.lib.id, bad)).status, bad).toBe(400);
  });

  it("a big block is read in pages with a cursor until complete", async () => {
    const w = await world(0);
    for (let i = 0; i < 520; i++) await makeTitle(db, w.lib.id, { kind: "photo", name: `p${i}`, boxFolderId: `file:big${++n}`, takenAt: new Date(Date.UTC(2024, 4, 1, 0, 0, i)), takenAtSource: "box" });
    const first = await (await get(w.lib.id, "?bucket=2024-05")).json();
    expect(first.items).toHaveLength(500);
    expect(typeof first.next).toBe("string");
    const second = await (await get(w.lib.id, `?bucket=2024-05&after=${encodeURIComponent(first.next)}`)).json();
    expect(second.items).toHaveLength(20);
    expect(second.next).toBeNull();
    expect(new Set([...first.items, ...second.items].map((i: { id: string }) => i.id)).size).toBe(520);
  }, 60_000);
});

describe("search and the blocks' counts through the API", () => {
  const monthsOf = (id: string, query = "") => getMonths(new Request(`http://x/api/libraries/${id}/photos/months${query}`), ctx(id));

  it("narrows by a query and by block, with the viewer's age limit still applied", async () => {
    const w = await world(0);
    const mk = (name: string, at: string, ages: unknown = { ANY: 8 }) => makeTitle(db, w.lib.id, { kind: "photo", name, boxFolderId: `file:q${++n}`, takenAt: new Date(at), takenAtSource: "box", ratingAges: ages as never });
    await mk("beach mar", "2024-03-10T00:00:00Z");
    await mk("beach feb", "2024-02-10T00:00:00Z");
    await mk("beach adult", "2024-03-11T00:00:00Z", { ANY: 18 });
    await mk("city", "2024-03-12T00:00:00Z");
    await signInAs(w.member.accountId, { maxAge: 12, allowUnrated: false } as never);
    const names = async (query: string) => ((await (await get(w.lib.id, query)).json()).items as { name: string }[]).map((i) => i.name);
    expect(await names("?q=beach")).toEqual(["beach mar", "beach feb"]);
    expect(await names("?q=2024-02")).toEqual(["beach feb"]);
    expect(await names("?bucket=2024-03&q=beach")).toEqual(["beach mar"]);
    expect(await names("?bucket=2024-03")).toEqual(["city", "beach mar"]); // the adult one never appears
  });

  it("months: counts for the same narrowing, uniform 404s, a rate limit and a private response", async () => {
    const w = await world(0);
    await makeTitle(db, w.lib.id, { kind: "photo", name: "a", boxFolderId: `file:m${++n}`, takenAt: new Date("2024-03-10T00:00:00Z"), ratingAges: { ANY: 8 } as never });
    await makeTitle(db, w.lib.id, { kind: "photo", name: "b", boxFolderId: `file:m${++n}`, takenAt: new Date("2024-02-10T00:00:00Z"), ratingAges: { ANY: 8 } as never });
    const ok = await monthsOf(w.lib.id);
    expect([ok.status, ok.headers.get("cache-control")]).toEqual([200, "private, no-store"]);
    expect((await ok.json()).months).toEqual([{ key: "2024-03", count: 1 }, { key: "2024-02", count: 1 }]);
    expect((await (await monthsOf(w.lib.id, "?q=a")).json()).months).toEqual([{ key: "2024-03", count: 1 }]);
    const video = await makeLibrary(db, w.server.id, "video", "everyone");
    const outcomes = new Set<string>();
    for (const id of ["nope", "00000000-0000-4000-8000-0000000000fa", video.id]) {
      const r = await monthsOf(id);
      outcomes.add(`${r.status} ${JSON.stringify(await r.json())}`);
    }
    h.resolution = null;
    const out = await monthsOf(w.lib.id);
    outcomes.add(`${out.status} ${JSON.stringify(await out.json())}`);
    expect([...outcomes]).toEqual([`404 ${JSON.stringify({ error: "Not found" })}`]);
    await signInAs(w.member.accountId);
    h.limited = true;
    expect((await monthsOf(w.lib.id)).status).toBe(429);
    h.limited = false;
  });
});
