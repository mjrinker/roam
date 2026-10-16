/** The watch list on a TV: the home row, the buttons on a page, and the route behind them. */
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
    getCurrentServerMember: async (serverId: string) => {
      const account = h.profile as { id: string } | null;
      const resolved = h.resolution as { viewer: unknown } | null;
      if (!account || !resolved) return null;
      const [m] = await h.testDb.db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.profileId, account.id), eq(serverMembers.serverId, serverId))).limit(1);
      return m ? { profile: account, role: m.role, viewer: resolved.viewer } : null;
    },
    getServerMembership: async (profileId: string, serverId: string) =>
      (await h.testDb.db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.profileId, profileId), eq(serverMembers.serverId, serverId))).limit(1))[0] ?? null,
  };
});
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { signOut: async () => void h.signedOut++ } }) }));

import { profiles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb, autoFiles } from "@/lib/playlists/test-db";


import { GET as titlePage } from "./s/[serverId]/title/[id]/route";
import { GET as showPage } from "./s/[serverId]/show/[id]/route";
import { GET as homePage } from "./s/[serverId]/route";
import { GET as listGet, POST as listPost } from "./s/[serverId]/watchlist/route";
import { onWatchlist } from "@/lib/watchlist/queries";


autoFiles();
let db: TestDb;
beforeAll(() => { db = h.testDb.db; });
beforeEach(() => { h.resolution = null; h.profile = null; h.jar.clear(); });

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const post = (fields: Record<string, string>, headers: Record<string, string> = {}) => new Request("https://roam.example/x", { method: "POST", headers, body: new URLSearchParams(fields) });
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
  const film = await makeTitle(db, lib.id, { kind: "movie", name: "Film" });
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const { show } = await makeShow(db, shows.id, 2, { name: "Show" });
  return { server, member, film, show, sid: { serverId: server.id } };
}

describe("the watch list on a TV", () => {
  it("offers adding on a movie's page, then taking off, and lists it on the home screen", async () => {
    const w = await world();
    const page = async () => text(await titlePage(new Request("https://roam.example/x"), ctx({ ...w.sid, id: w.film.id })));
    expect(await page()).toContain("Add to watch list");
    expect(await page()).toContain(`/tv/s/${w.server.id}/watchlist`);
    expect(await text(await homePage(new Request("https://roam.example/x"), ctx(w.sid)))).not.toContain("Your watch list");
    expect((await listPost(post({ id: w.film.id, on: "1", back: `/tv/s/${w.server.id}/title/${w.film.id}` }), ctx(w.sid))).status).toBe(303);
    expect((await onWatchlist(db, w.member.viewer.id, [w.film.id])).has(w.film.id)).toBe(true);
    const after = await page();
    expect(after).toContain("Take off watch list");
    expect(await text(await homePage(new Request("https://roam.example/x"), ctx(w.sid)))).toContain("Your watch list");
    await listPost(post({ id: w.film.id, on: "0" }), ctx(w.sid));
    expect((await onWatchlist(db, w.member.viewer.id, [w.film.id])).size).toBe(0);
  });

  it("works for a show too", async () => {
    const w = await world();
    const page = async () => text(await showPage(new Request("https://roam.example/x"), ctx({ ...w.sid, id: w.show.id })));
    expect(await page()).toContain("Add to watch list");
    await listPost(post({ id: w.show.id, on: "1" }), ctx(w.sid));
    expect(await page()).toContain("Take off watch list");
  });

  it("refuses nonsense, other sites, and opening the address in a browser", async () => {
    const w = await world();
    for (const on of ["2", "yes", ""]) expect((await listPost(post({ id: w.film.id, on }), ctx(w.sid))).status).toBe(404);
    expect((await listPost(post({ id: "nope", on: "1" }), ctx(w.sid))).status).toBe(404);
    expect((await listPost(post({ id: w.film.id, on: "1" }, { origin: "https://evil.example" }), ctx(w.sid))).status).toBe(404);
    expect((await onWatchlist(db, w.member.viewer.id, [w.film.id])).size).toBe(0);
    const res = await listGet(new Request("https://roam.example/x"), ctx(w.sid));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
  });
});
