/** Shuffling a playlist on a TV, and Back returning to the playlist. */
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
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";


import { GET as playRoute } from "./s/[serverId]/playlist/[id]/play/route";
import { GET as playlistPage } from "./s/[serverId]/playlist/[id]/route";
import { GET as watchRoute } from "./s/[serverId]/watch/[kind]/[id]/route";
import { addItem, makePlaylist } from "@/lib/playlists/test-db";
import { mediaFiles } from "@/lib/db/schema";

let db: TestDb;
beforeAll(() => { db = h.testDb.db; });
beforeEach(() => { h.resolution = null; h.profile = null; h.jar.clear(); });

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
  const playlist = await makePlaylist(db, { serverId: server.id, ownerViewerId: member.viewer.id, name: "Mine" });
  const films = [];
  for (let i = 0; i < 4; i++) {
    const t = await makeTitle(db, lib.id, { kind: "movie", name: `Film ${i}` });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, boxFileId: `shuf${i}${t.id}`, filename: "f.mp4" });
    films.push({ title: t, item: await addItem(db, playlist.id, { titleId: t.id }, (i + 1) * 1024) });
  }
  return { server, member, playlist, films, sid: { serverId: server.id } };
}

describe("shuffling on a TV", () => {
  it("offers Shuffle beside Play all, which starts a random order that rides along in the address", async () => {
    const w = await world();
    const page = await text(await playlistPage(new Request("https://roam.example/x"), ctx({ ...w.sid, id: w.playlist.id })));
    expect(page).toContain("Play all");
    expect(page).toContain("Shuffle");
    expect(page).toContain(`/playlist/${w.playlist.id}/play?shuffle=1`);
    const res = await playRoute(new Request(`https://roam.example/x?shuffle=1`), ctx({ ...w.sid, id: w.playlist.id }));
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/\/watch\/title\/[0-9a-f-]+\?playlist=.*&item=.*&shuffle=[0-9a-f]{16}$/);
    const again = (await playRoute(new Request(`https://roam.example/x?shuffle=1`), ctx({ ...w.sid, id: w.playlist.id }))).headers.get("location");
    expect(again).not.toBe(location); // a fresh shuffle each time
    const plain = (await playRoute(new Request(`https://roam.example/x`), ctx({ ...w.sid, id: w.playlist.id }))).headers.get("location") ?? "";
    expect(plain).not.toContain("shuffle");
    expect(plain).toContain(`item=${w.films[0].item.id}`);
  });

  it("keeps the same order from one film to the next, and Back goes to the playlist", async () => {
    const w = await world();
    const start = (await playRoute(new Request(`https://roam.example/x?shuffle=1`), ctx({ ...w.sid, id: w.playlist.id }))).headers.get("location") as string;
    const seed = /shuffle=([0-9a-f]+)/.exec(start)?.[1] as string;
    const visited: string[] = [];
    let url: string | null = start;
    for (let i = 0; i < 6 && url; i++) {
      const u = new URL(url);
      const m = /\/watch\/(title|episode)\/([0-9a-f-]+)$/.exec(u.pathname);
      expect(m).not.toBeNull();
      const html = await text(await watchRoute(new Request(url), ctx({ ...w.sid, kind: m![1], id: m![2] })));
      visited.push(m![2]);
      expect(html).toContain(`/tv/s/${w.server.id}/playlist/${w.playlist.id}`); // Back
      const next = /"next":"([^"]+)"/.exec(html)?.[1];
      url = next ? `https://roam.example${next.replace(/\\u0026/g, "&")}` : null;
      if (url) expect(url).toContain(`shuffle=${seed}`);
    }
    expect(new Set(visited).size).toBe(4); // every film once
    expect(visited).toHaveLength(4);
  });
});
