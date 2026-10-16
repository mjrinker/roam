/** The TV library page's sort, filter and letter controls, and the pages that choose a genre or owner. */
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
import { GET as choose } from "./s/[serverId]/library/[id]/choose/route";


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
  return { server, lib, p: { serverId: server.id, id: lib.id } };
}

describe("the library page", () => {
  it("has the sort, genre and unwatched buttons and a row of letters, and clear filters once narrowed", async () => {
    const w = await world();
    await makeTitle(db, w.lib.id, { kind: "movie", name: "Alpha", genres: ["Drama"] });
    const page = await text(await library(req("/x"), ctx(w.p)));
    expect(page).toContain("Sort: Title");
    expect(page).toContain("Genre: Any");
    expect(page).toContain("Unwatched only: Off");
    expect(page).not.toContain("Clear filters");
    expect(page).toContain("letter=K");
    const narrowed = await text(await library(req("/x?genre=Drama&unwatched=1&sort=year"), ctx(w.p)));
    expect(narrowed).toContain("Sort: Newest year first");
    expect(narrowed).toContain("Genre: Drama");
    expect(narrowed).toContain("Unwatched only: On");
    expect(narrowed).toContain("Clear filters");
    expect(narrowed).not.toContain("letter=K"); // letters only make sense in title order
    expect(narrowed).not.toContain("Owner:"); // this server doesn't track ownership
  });
  it("sends a letter to the page it starts on, keeping the other options", async () => {
    const w = await world();
    for (let i = 0; i < 30; i++) await makeTitle(db, w.lib.id, { kind: "movie", name: `A${String(i).padStart(2, "0")}`, genres: ["Drama"] });
    await makeTitle(db, w.lib.id, { kind: "movie", name: "Zed", genres: ["Drama"] });
    const res = await library(req("/x?letter=Z&genre=Drama"), ctx(w.p));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("page=2");
    expect(res.headers.get("location")).toContain("genre=Drama");
    expect((await library(req("/x?letter=A"), ctx(w.p))).headers.get("location")).not.toContain("page=");
  });
});

describe("choosing a genre", () => {
  it("lists the genres with counts, and each choice leads back with it set", async () => {
    const w = await world();
    await makeTitle(db, w.lib.id, { kind: "movie", name: "A", genres: ["Drama"] });
    await makeTitle(db, w.lib.id, { kind: "movie", name: "B", genres: ["Drama", "Comedy"] });
    const page = await text(await choose(req("/x?what=genre&unwatched=1"), ctx(w.p)));
    expect(page).toContain("Any genre");
    expect(page).toContain("2 titles");
    expect(page).toContain("1 title<");
    expect(page).toContain("genre=Drama");
    expect(page).toContain("unwatched=1");
  });
  it("is not found for anything else, or for a server that doesn't track ownership", async () => {
    const w = await world();
    expect((await choose(req("/x?what=owner"), ctx(w.p))).status).toBe(404);
    expect((await choose(req("/x?what=zzz"), ctx(w.p))).status).toBe(404);
  });
});
