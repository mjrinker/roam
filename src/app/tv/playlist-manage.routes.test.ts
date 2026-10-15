/** Playlists on a TV: making, naming, renaming, arranging, removing from and deleting them, and who may. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { addItem, addMember, joinServer, makeAccount, makeLibrary, makePlaylist, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { tvPlaylist, tvPlaylists } from "@/lib/tv/playlists";

import { GET as playlistsList } from "./s/[serverId]/playlists/route";
import { GET as nameGet } from "./s/[serverId]/playlists/name/route";
import { GET as saveGet, POST as savePost } from "./s/[serverId]/playlists/save/route";
import { GET as playlistPage } from "./s/[serverId]/playlist/[id]/route";
import { GET as arrangeGet } from "./s/[serverId]/playlist/[id]/arrange/route";
import { GET as changeGet, POST as changePost } from "./s/[serverId]/playlist/[id]/change/route";
import { GET as deleteGet, POST as deletePost } from "./s/[serverId]/playlist/[id]/delete/route";
import { GET as addGet } from "./s/[serverId]/add/route";

let db: TestDb;
beforeAll(() => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  db = h.testDb.db;
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  h.resolution = null;
  h.profile = null;
  h.jar.clear();
});

const req = (path: string) => new Request(`https://roam.example${path}`);
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const text = async (r: Response) => r.text();
const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => new Request(`https://roam.example${path}`, { method: "POST", headers, body: new URLSearchParams(fields) });

async function signIn(who: Awaited<ReturnType<typeof makeAccount>>) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, who.accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, who.accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
  h.profile = account;
}

let n = 0;
async function world() {
  const admin = await makeAccount(db, `admin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const owner = await makeAccount(db, `owner${++n}`);
  const other = await makeAccount(db, `other${++n}`);
  for (const m of [owner, other]) await joinServer(db, server.id, m.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const films = [] as Awaited<ReturnType<typeof makeTitle>>[];
  for (const name of ["Alpha", "Bravo", "Charlie"]) films.push(await makeTitle(db, movies.id, { kind: "movie", name }));
  await signIn(owner);
  const list = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id, name: "Weekend" });
  for (const [i, f] of films.entries()) await addItem(db, list.id, { titleId: f.id }, (i + 1) * 1024);
  const sid = { serverId: server.id };
  const order = async () => (await tvPlaylist(db, { actor: { serverId: server.id, accountId: owner.accountId, isAdmin: false }, viewer: { locale: "en-US", maxAge: null, allowUnrated: true }, viewerId: owner.viewer.id }, list.id, null))!.items.map((i) => i.name);
  const itemIds = async () => (await tvPlaylist(db, { actor: { serverId: server.id, accountId: owner.accountId, isAdmin: false }, viewer: { locale: "en-US", maxAge: null, allowUnrated: true }, viewerId: owner.viewer.id }, list.id, null))!.items.map((i) => i.id);
  return { admin, server, owner, other, films, list, sid, order, itemIds };
}
const ids = (w: { server: { id: string }; list: { id: string } }) => ({ serverId: w.server.id, id: w.list.id });

describe("making a playlist", () => {
  it("offers New playlist on the list, even with none yet", async () => {
    const w = await world();
    expect(await text(await playlistsList(req("/x"), ctx(w.sid)))).toContain("New playlist");
    const lonely = await world();
    await db.delete((await import("@/lib/db/schema")).playlists);
    expect(await text(await playlistsList(req("/x"), ctx(lonely.sid)))).toContain(`/playlists/name`);
  });

  it("types a name on a keyboard (each word starts with a capital), and Save makes the playlist and opens it", async () => {
    const w = await world();
    const page = await text(await nameGet(req("/x?name=Road%20t&k=t"), ctx(w.sid)));
    expect(page).toContain("New playlist");
    expect(page).toContain("Road t");
    expect(page).toContain("name=Road+tr&amp;k=r"); // the next letter: lower case inside a word
    expect(await text(await nameGet(req("/x?name=Road%20&k=space"), ctx(w.sid)))).toContain("name=Road+T&amp;k=t"); // a capital after a space
    expect(await text(await nameGet(req("/x"), ctx(w.sid)))).toContain("name=A&amp;k=a"); // and for the first letter
    expect(await text(await nameGet(req("/x"), ctx(w.sid)))).not.toContain(">Create<"); // nothing to save yet
    expect(await text(await nameGet(req("/x?name=Road%20trip"), ctx(w.sid)))).toContain(">Create<");
    const res = await savePost(post("/x", { name: "  Road trip  ", back: "/tv/s/x/playlists" }), ctx(w.sid));
    expect(res.status).toBe(303);
    const made = (await tvPlaylists(db, { actor: { serverId: w.server.id, accountId: w.owner.accountId, isAdmin: false }, viewer: { locale: "en-US", maxAge: null, allowUnrated: true }, viewerId: w.owner.viewer.id })).find((p) => p.name === "Road trip");
    expect(made).toBeTruthy();
    expect(res.headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}/playlist/${made!.id}`);
  });

  it("does nothing for an empty name, from another site, or by just opening the address", async () => {
    const w = await world();
    const before = (await tvPlaylists(db, { actor: { serverId: w.server.id, accountId: w.owner.accountId, isAdmin: false }, viewer: { locale: "en-US", maxAge: null, allowUnrated: true }, viewerId: w.owner.viewer.id })).length;
    expect((await savePost(post("/x", { name: "   " }), ctx(w.sid))).headers.get("location")).toContain("/playlists");
    expect((await savePost(post("/x", { name: "Sneaky" }, { origin: "https://evil.example" }), ctx(w.sid))).status).toBe(404);
    expect((await saveGet(req("/x"), ctx(w.sid))).headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}/playlists`);
    expect((await tvPlaylists(db, { actor: { serverId: w.server.id, accountId: w.owner.accountId, isAdmin: false }, viewer: { locale: "en-US", maxAge: null, allowUnrated: true }, viewerId: w.owner.viewer.id })).length).toBe(before);
  });

  it("makes a new playlist while adding something, and refuses a target it may not add without leaving an empty one", async () => {
    const w = await world();
    const addPage = await text(await addGet(req(`/x?title=${w.films[0].id}&back=${encodeURIComponent(`/tv/s/${w.server.id}/title/${w.films[0].id}`)}`), ctx(w.sid)));
    expect(addPage).toContain("New playlist…");
    expect(addPage).toContain(`/playlists/name?title=${w.films[0].id}`);
    const naming = await text(await nameGet(req(`/x?title=${w.films[0].id}&name=Faves`), ctx(w.sid)));
    expect(naming).toContain("Create and add");
    const res = await savePost(post("/x", { name: "Faves", title: w.films[0].id, back: `/tv/s/${w.server.id}/title/${w.films[0].id}` }), ctx(w.sid));
    expect(await text(res)).toContain("Added to your playlist");
    const scope = { actor: { serverId: w.server.id, accountId: w.owner.accountId, isAdmin: false }, viewer: { locale: "en-US", maxAge: null, allowUnrated: true }, viewerId: w.owner.viewer.id };
    const faves = (await tvPlaylists(db, scope)).find((p) => p.name === "Faves")!;
    expect(faves.itemCount).toBe(1);
    const other = await world();
    await signIn(w.owner);
    const count = (await tvPlaylists(db, scope)).length;
    expect((await savePost(post("/x", { name: "Nope", title: other.films[0].id }), ctx(w.sid))).status).toBe(404);
    expect((await tvPlaylists(db, scope)).length).toBe(count);
  });
});

describe("renaming and deleting", () => {
  it("lets the owner rename (the name is filled in), and nobody who can't", async () => {
    const w = await world();
    const page = await text(await playlistPage(req("/x"), ctx(ids(w))));
    expect(page).toContain("Rename");
    expect(page).toContain("Arrange");
    expect(page).toContain("Delete");
    const naming = await text(await nameGet(req(`/x?playlist=${w.list.id}&name=Weekend`), ctx(w.sid)));
    expect(naming).toContain("Rename playlist");
    expect(naming).toContain(">Save<");
    const res = await savePost(post("/x", { name: "Long weekend", playlist: w.list.id }), ctx(w.sid));
    expect(res.headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}/playlist/${w.list.id}`);
    expect(await text(await playlistPage(req("/x"), ctx(ids(w))))).toContain("Long weekend");
    // someone it is only shared with (as a viewer) can look but not change anything
    await addMember(db, w.list.id, w.other.viewer.id);
    await signIn(w.other);
    const theirs = await text(await playlistPage(req("/x"), ctx(ids(w))));
    expect(theirs).not.toContain("Arrange");
    expect(theirs).not.toContain(">Rename<");
    expect((await nameGet(req(`/x?playlist=${w.list.id}`), ctx(w.sid))).status).toBe(404);
    expect((await savePost(post("/x", { name: "Mine now", playlist: w.list.id }), ctx(w.sid))).status).toBe(404);
  });

  it("asks before deleting, deletes for the owner only, and ignores a GET or another site", async () => {
    const w = await world();
    const ask = await text(await deleteGet(req("/x"), ctx(ids(w))));
    expect(ask).toContain("Delete &ldquo;Weekend&rdquo;?");
    expect(ask).toContain("Yes, delete it");
    expect(ask).toContain("No, keep it");
    expect((await deletePost(post("/x", {}, { origin: "https://evil.example" }), ctx(ids(w)))).status).toBe(404);
    await signIn(w.other);
    await addMember(db, w.list.id, w.other.viewer.id);
    expect((await deleteGet(req("/x"), ctx(ids(w)))).status).toBe(404);
    expect((await deletePost(post("/x", {}), ctx(ids(w)))).status).toBe(404);
    await signIn(w.owner);
    const res = await deletePost(post("/x", {}), ctx(ids(w)));
    expect(res.headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}/playlists`);
    expect((await playlistPage(req("/x"), ctx(ids(w)))).status).toBe(404);
  });
});

describe("arranging", () => {
  it("lists the items with Move up (not on the first), Move down (not on the last) and Remove", async () => {
    const w = await world();
    const page = await text(await arrangeGet(req("/x"), ctx(ids(w))));
    expect(page).toContain("1. Alpha");
    expect(page).toContain("3. Charlie");
    expect(page.match(/Move up/g)).toHaveLength(2);
    expect(page.match(/Move down/g)).toHaveLength(2);
    expect(page.match(/>Remove</g)).toHaveLength(3);
  });

  it("moves an item up and down one place at a time, and lands back on the same button", async () => {
    const w = await world();
    const [a, b, c] = await w.itemIds();
    const change = (item: string, action: string) => changePost(post("/x", { action, item }), ctx(ids(w)));
    const res = await change(c, "up");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}/playlist/${w.list.id}/arrange?f=${c}:up`);
    expect(await w.order()).toEqual(["Alpha", "Charlie", "Bravo"]);
    await change(c, "up");
    expect(await w.order()).toEqual(["Charlie", "Alpha", "Bravo"]);
    await change(c, "up"); // already first: nothing happens
    expect(await w.order()).toEqual(["Charlie", "Alpha", "Bravo"]);
    await change(c, "down");
    await change(c, "down");
    expect(await w.order()).toEqual(["Alpha", "Bravo", "Charlie"]);
    await change(c, "down"); // already last
    expect(await w.order()).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect([a, b].length).toBe(2);
    const landed = await text(await arrangeGet(req(`/x?f=${c}:up`), ctx(ids(w))));
    expect(landed).toMatch(new RegExp(`name="item" value="${c}"><button[^>]*data-autofocus>Move up`));
  });

  it("removes an item", async () => {
    const w = await world();
    const [, b] = await w.itemIds();
    const res = await changePost(post("/x", { action: "remove", item: b }), ctx(ids(w)));
    expect(res.headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}/playlist/${w.list.id}/arrange`);
    expect(await w.order()).toEqual(["Alpha", "Charlie"]);
  });

  it("is only for those who may change the items, and never from another site, a GET or with a bad request", async () => {
    const w = await world();
    const [a] = await w.itemIds();
    await addMember(db, w.list.id, w.other.viewer.id);
    await signIn(w.other);
    expect((await arrangeGet(req("/x"), ctx(ids(w)))).status).toBe(404);
    expect((await changePost(post("/x", { action: "remove", item: a }), ctx(ids(w)))).status).toBe(404);
    await signIn(w.owner);
    expect((await changePost(post("/x", { action: "remove", item: a }, { origin: "https://evil.example" }), ctx(ids(w)))).status).toBe(404);
    expect((await changePost(post("/x", { action: "explode", item: a }), ctx(ids(w)))).status).toBe(404);
    expect((await changePost(post("/x", { action: "up", item: "not-a-uuid" }), ctx(ids(w)))).status).toBe(404);
    expect((await changeGet(req("/x"), ctx(ids(w)))).headers.get("location")).toBe(`https://roam.example/tv/s/${w.server.id}/playlist/${w.list.id}`);
    expect(await w.order()).toEqual(["Alpha", "Bravo", "Charlie"]);
    const stranger = await world();
    await signIn(w.owner);
    expect((await arrangeGet(req("/x"), ctx({ serverId: stranger.server.id, id: w.list.id }))).status).toBe(404);
  });
});
