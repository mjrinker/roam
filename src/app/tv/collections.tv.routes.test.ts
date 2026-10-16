/** The TV's collection pages and the Collections button on a library list. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  resolution: null as unknown,
  profile: null as unknown,
  jar: new Map<string, string>(),
  signedOut: 0,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void h.jar.set(name, value),
    delete: (arg: string | { name: string }) => void h.jar.delete(typeof arg === "string" ? arg : arg.name),
  }),
}));
vi.mock("@/lib/auth/viewer", async () => {
  const { eq } = await import("drizzle-orm");
  const { viewers } = await import("@/lib/db/schema");
  return {
    getCurrentViewer: async () => h.resolution,
    listViewers: async (accountId: string) => h.testDb.db.select().from(viewers).where(eq(viewers.accountId, accountId)),
  };
});
vi.mock("@/lib/auth/guards", async () => {
  const { and, eq } = await import("drizzle-orm");
  const { serverMembers } = await import("@/lib/db/schema");
  return {
    getCurrentProfile: async () => h.profile,
    getServerMembership: async (profileId: string, serverId: string) =>
      (await h.testDb.db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.profileId, profileId), eq(serverMembers.serverId, serverId))).limit(1))[0] ?? null,
  };
});
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { signOut: async () => void h.signedOut++ } }) }));

import { profiles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb, autoFiles } from "@/lib/playlists/test-db";


import { GET as library } from "./s/[serverId]/library/[id]/route";
import { GET as collectionList } from "./s/[serverId]/collections/[libraryId]/route";
import { GET as collectionOne } from "./s/[serverId]/collection/[id]/route";
import { syncSeriesCollections } from "@/lib/collections/sync";
import { collections } from "@/lib/db/schema";
import { GET as titlePage } from "./s/[serverId]/title/[id]/route";


autoFiles();
let db: TestDb;
beforeAll(() => { db = h.testDb.db; });
beforeEach(() => { h.resolution = null; h.profile = null; h.jar.clear(); });

const req = (path: string) => new Request(`https://roam.example${path}`);
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const text = async (r: Response) => r.text();

async function world() {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const [account] = await db.select().from(profiles).where(eq(profiles.id, member.accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, member.accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
  h.profile = account;
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  return { server, lib, sid: { serverId: server.id } };
}
const series = (libraryId: string, name: string, year: number) => makeTitle(db, libraryId, { kind: "movie", name, year, collectionTmdbId: 1, collectionName: "Alien Collection", posterUrl: "https://img/x.jpg" });

describe("collections on a TV", () => {
  it("shows a Collections button on a library that has some, and none on one that has not", async () => {
    const w = await world();
    await makeTitle(db, w.lib.id, { kind: "movie", name: "Lone" });
    expect(await text(await library(req("/x"), ctx({ ...w.sid, id: w.lib.id })))).not.toContain("Collections (");
    await series(w.lib.id, "Alien", 1979);
    await series(w.lib.id, "Aliens", 1986);
    await syncSeriesCollections(db, w.lib.id);
    const page = await text(await library(req("/x"), ctx({ ...w.sid, id: w.lib.id })));
    expect(page).toContain("Collections (1)");
    expect(page).toContain(`/tv/s/${w.server.id}/collections/${w.lib.id}`);
  });

  it("lists them, opens one, and goes back to the list", async () => {
    const w = await world();
    await series(w.lib.id, "Aliens", 1986);
    await series(w.lib.id, "Alien", 1979);
    await syncSeriesCollections(db, w.lib.id);
    const list = await text(await collectionList(req("/x"), ctx({ ...w.sid, libraryId: w.lib.id })));
    expect(list).toContain("Alien Collection");
    expect(list).toContain("2 titles");
    const [c] = await db.select().from(collections).where(eq(collections.libraryId, w.lib.id));
    const one = await text(await collectionOne(req("/x"), ctx({ ...w.sid, id: c.id })));
    expect(one.indexOf(">Alien<")).toBeLessThan(one.indexOf(">Aliens<")); // oldest first
    expect(one).toContain(`/tv/s/${w.server.id}/title/`);
    expect(one).toContain(`/tv/s/${w.server.id}/collections/${w.lib.id}`);
  });

  it("is not found for another server's collection, a bad id, or a library with no grid", async () => {
    const other = await world();
    await series(other.lib.id, "Alien", 1979);
    await series(other.lib.id, "Aliens", 1986);
    await syncSeriesCollections(db, other.lib.id);
    const [c] = await db.select().from(collections).where(eq(collections.libraryId, other.lib.id));
    const w = await world();
    expect((await collectionOne(req("/x"), ctx({ ...w.sid, id: c.id }))).status).toBe(404);
    expect((await collectionOne(req("/x"), ctx({ ...w.sid, id: "nope" }))).status).toBe(404);
    expect((await collectionList(req("/x"), ctx({ ...w.sid, libraryId: other.lib.id }))).status).toBe(404);
  });

  it("shows the rest of a collection on a movie's page", async () => {
    const w = await world();
    const alien = await series(w.lib.id, "Alien", 1979);
    const aliens = await series(w.lib.id, "Aliens", 1986);
    await syncSeriesCollections(db, w.lib.id);
    const page = await text(await titlePage(req("/x"), ctx({ ...w.sid, id: alien.id })));
    expect(page).toContain("More in Alien Collection");
    expect(page).toContain(`/tv/s/${w.server.id}/title/${aliens.id}`);
  });
});
