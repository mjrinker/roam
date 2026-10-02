/**
 * The playlist route handlers, called for real against an in-memory Postgres.
 * Only the login lookup and the rate limiter are faked. Covers the HTTP
 * contract: auth states, validation, status codes, the end-to-end flow, and
 * that nothing leaks across servers or restrictions.
 */
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
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, delete: () => undefined }) }));

import { profiles, viewers } from "@/lib/db/schema";
import { addMember, joinServer, makeAccount, makeLibrary, makePlaylist, makeServer, makeTitle, makeViewer, addItem } from "@/lib/playlists/test-db";
import * as playlistRoute from "./[id]/route";
import * as itemsRoute from "./[id]/items/route";
import * as itemRoute from "./[id]/items/[itemId]/route";
import * as membersRoute from "./[id]/members/route";
import * as copyRoute from "./[id]/copy/route";
import * as transferRoute from "./[id]/transfer/route";
import * as nextRoute from "./[id]/next/route";
import * as serverPlaylists from "../servers/[serverId]/playlists/route";
import * as moderationRoute from "../servers/[serverId]/playlists/moderation/route";
import * as pickerRoute from "../servers/[serverId]/viewers/route";
import * as forItemRoute from "../servers/[serverId]/playlists/for-item/route";

let db: import("@/lib/playlists/test-db").TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
beforeEach(() => {
  h.resolution = null;
  h.withinLimit = true;
});

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const req = (method: string, body?: unknown, url = "http://x/api") =>
  new Request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const body = async (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signInAs(accountId: string, viewerId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all.find((v) => v.id === viewerId), viewers: all };
}

async function world() {
  const owner = await makeAccount(db, "owner");
  const server = await makeServer(db, owner.accountId);
  const library = await makeLibrary(db, server.id);
  const friend = await makeAccount(db, "friend");
  await joinServer(db, server.id, friend.accountId);
  return { owner, server, library, friend };
}

describe("auth and validation", () => {
  it("401 when signed out, 403 viewer_required when no profile is chosen", async () => {
    const { server } = await world();
    const c = ctx({ serverId: server.id });
    expect((await serverPlaylists.GET(req("GET"), c)).status).toBe(401);
    const acct = await makeAccount(db, "chooser");
    const [account] = await db.select().from(profiles).where(eq(profiles.id, acct.accountId));
    h.resolution = { account, viewer: null, viewers: [] };
    const res = await serverPlaylists.GET(req("GET"), c);
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: "viewer_required" });
  });

  it("404 for malformed ids; 400 for bad bodies; 429 when throttled", async () => {
    const { owner, server } = await world();
    await signInAs(owner.accountId, owner.viewer.id);
    expect((await playlistRoute.GET(req("GET"), ctx({ id: "not-a-uuid" }))).status).toBe(404);
    expect((await serverPlaylists.POST(req("POST", { name: "   " }), ctx({ serverId: server.id }))).status).toBe(400);
    expect((await serverPlaylists.POST(req("POST", { name: "x".repeat(101) }), ctx({ serverId: server.id }))).status).toBe(400);
    expect((await serverPlaylists.POST(req("POST", { name: "ok", description: "d".repeat(501) }), ctx({ serverId: server.id }))).status).toBe(400);
    expect((await serverPlaylists.GET(req("GET", undefined, "http://x/api?scope=bogus"), ctx({ serverId: server.id }))).status).toBe(400);
    expect((await serverPlaylists.GET(req("GET", undefined, "http://x/api?after=%%%"), ctx({ serverId: server.id }))).status).toBe(400);
    h.withinLimit = false;
    expect((await serverPlaylists.POST(req("POST", { name: "ok" }), ctx({ serverId: server.id }))).status).toBe(429);
  });

  it("ignores any viewer id in the request: the actor always comes from the session", async () => {
    const { owner, server, friend } = await world();
    await signInAs(owner.accountId, owner.viewer.id);
    const res = await serverPlaylists.POST(req("POST", { name: "Mine", ownerViewerId: friend.viewer.id, viewerId: friend.viewer.id }), ctx({ serverId: server.id }));
    expect(res.status).toBe(201);
    const detail = await playlistRoute.GET(req("GET"), ctx({ id: (await body(res)).id }));
    expect((await body(detail)).owner.id).toBe(owner.viewer.id);
  });
});

describe("end-to-end flow", () => {
  it("create, add, list, move, share, copy, leave, transfer, delete", async () => {
    const { owner, server, library, friend } = await world();
    const a = await makeTitle(db, library.id, { name: "A" });
    const b = await makeTitle(db, library.id, { name: "B" });
    await signInAs(owner.accountId, owner.viewer.id);

    const created = await body(await serverPlaylists.POST(req("POST", { name: "  Weekend  ", description: "movies" }), ctx({ serverId: server.id })));
    expect(created).toMatchObject({ name: "Weekend", visibility: "private" });
    const id = created.id as string;

    const addA = await itemsRoute.POST(req("POST", { titleId: a.id }), ctx({ id }));
    const addB = await itemsRoute.POST(req("POST", { titleId: b.id }), ctx({ id }));
    expect([addA.status, addB.status]).toEqual([201, 201]);
    expect((await itemsRoute.POST(req("POST", { titleId: a.id }), ctx({ id }))).status).toBe(409);
    expect((await itemsRoute.POST(req("POST", {}), ctx({ id }))).status).toBe(400);
    expect((await itemsRoute.POST(req("POST", { titleId: a.id, episodeId: b.id }), ctx({ id }))).status).toBe(400);

    const items = await body(await itemsRoute.GET(req("GET", undefined, "http://x/api?limit=1"), ctx({ id })));
    expect(items.items.map((i: { name: string }) => i.name)).toEqual(["A"]);
    expect(items.nextCursor).toBeTruthy();
    const page2 = await body(await itemsRoute.GET(req("GET", undefined, `http://x/api?limit=1&after=${items.nextCursor}`), ctx({ id })));
    expect(page2.items.map((i: { name: string }) => i.name)).toEqual(["B"]);
    expect(page2.nextCursor).toBeNull();

    const idB = (await body(addB)).id as string;
    expect((await itemsRoute.PATCH(req("PATCH", { itemId: idB, afterItemId: null }), ctx({ id }))).status).toBe(200);
    const reordered = await body(await itemsRoute.GET(req("GET"), ctx({ id })));
    expect(reordered.items.map((i: { name: string }) => i.name)).toEqual(["B", "A"]);

    // Share with the friend as an editor; the friend sees it and can add.
    const picker = await body(await pickerRoute.GET(req("GET"), ctx({ serverId: server.id })));
    expect(picker.viewers.map((v: { id: string }) => v.id)).toContain(friend.viewer.id);
    expect(Object.keys(picker.viewers[0]).sort()).toEqual(["avatarKey", "id", "name"]);
    expect((await membersRoute.POST(req("POST", { viewerId: friend.viewer.id, role: "editor" }), ctx({ id }))).status).toBe(201);
    const members = await body(await membersRoute.GET(req("GET"), ctx({ id })));
    expect(members.members).toHaveLength(1);

    await signInAs(friend.accountId, friend.viewer.id);
    const c = await makeTitle(db, library.id, { name: "C" });
    expect((await itemsRoute.POST(req("POST", { titleId: c.id }), ctx({ id }))).status).toBe(201);
    expect((await playlistRoute.DELETE(req("DELETE"), ctx({ id }))).status).toBe(403);

    // The friend copies it: theirs, private, 3 items, nobody else sees it.
    const copied = await copyRoute.POST(req("POST", {}), ctx({ id }));
    expect(copied.status).toBe(201);
    const copy = await body(copied);
    expect(copy).toMatchObject({ name: "Weekend (copy)", itemsCopied: 3 });
    await signInAs(owner.accountId, owner.viewer.id);
    expect((await playlistRoute.GET(req("GET"), ctx({ id: copy.id }))).status).toBe(404);

    // Owner transfers to the friend, who is then the owner and the old owner an editor.
    expect((await transferRoute.POST(req("POST", { viewerId: friend.viewer.id }), ctx({ id }))).status).toBe(200);
    expect((await body(await playlistRoute.GET(req("GET"), ctx({ id })))).myRole).toBe("editor");
    expect((await playlistRoute.DELETE(req("DELETE"), ctx({ id }))).status).toBe(403);
    // ... the old owner can leave, and the new owner can delete.
    expect((await membersRoute.DELETE(req("DELETE"), ctx({ id }))).status).toBe(200);
    expect((await playlistRoute.GET(req("GET"), ctx({ id }))).status).toBe(404);
    await signInAs(friend.accountId, friend.viewer.id);
    expect((await playlistRoute.DELETE(req("DELETE"), ctx({ id }))).status).toBe(200);
  });

  it("removes an item and answers 404 for one that isn't there", async () => {
    const { owner, server, library } = await world();
    await signInAs(owner.accountId, owner.viewer.id);
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const item = await addItem(db, p.id, { titleId: (await makeTitle(db, library.id)).id });
    expect((await itemRoute.DELETE(req("DELETE"), ctx({ id: p.id, itemId: item.id }))).status).toBe(200);
    expect((await itemRoute.DELETE(req("DELETE"), ctx({ id: p.id, itemId: item.id }))).status).toBe(404);
    expect((await itemRoute.DELETE(req("DELETE"), ctx({ id: p.id, itemId: "nope" }))).status).toBe(404);
  });
});

describe("isolation", () => {
  it("another server's members can't see, edit or share a playlist (all 404)", async () => {
    const { owner, server, library } = await world();
    const outsider = await makeAccount(db, "outsider");
    await makeServer(db, outsider.accountId); // their own, different server
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id, visibility: "server" });
    const t = await makeTitle(db, library.id);
    await signInAs(outsider.accountId, outsider.viewer.id);
    const id = p.id;
    const results = await Promise.all([
      playlistRoute.GET(req("GET"), ctx({ id })),
      itemsRoute.GET(req("GET"), ctx({ id })),
      itemsRoute.POST(req("POST", { titleId: t.id }), ctx({ id })),
      membersRoute.GET(req("GET"), ctx({ id })),
      copyRoute.POST(req("POST", {}), ctx({ id })),
      playlistRoute.DELETE(req("DELETE"), ctx({ id })),
    ]);
    expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404]);
    expect((await serverPlaylists.GET(req("GET"), ctx({ serverId: server.id }))).status).toBe(404);
  });

  it("a restricted profile never sees blocked items in lists or the queue", async () => {
    const { owner, server, library } = await world();
    const kid = await makeViewer(db, owner.accountId, { role: "limited", maxAge: 12, allowUnrated: false });
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: kid.id });
    const fine = await addItem(db, p.id, { titleId: (await makeTitle(db, library.id, { name: "Fine", ratingAges: { US: 0 } })).id }, 1024);
    await addItem(db, p.id, { titleId: (await makeTitle(db, library.id, { name: "Blocked", ratingAges: { US: 17 } })).id }, 2048);
    await signInAs(owner.accountId, kid.id);
    const list = await body(await itemsRoute.GET(req("GET"), ctx({ id: p.id })));
    expect(list.items.map((i: { name: string }) => i.name)).toEqual(["Fine"]);
    const next = await body(await nextRoute.GET(req("GET", undefined, `http://x/api?after=${fine.id}`), ctx({ id: p.id })));
    expect(next).toEqual({ next: null });
    const summary = await body(await serverPlaylists.GET(req("GET"), ctx({ serverId: server.id })));
    expect(summary.playlists[0].itemCount).toBe(1);
  });

  it("validates next's query parameters", async () => {
    const { owner, server } = await world();
    await signInAs(owner.accountId, owner.viewer.id);
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    expect((await nextRoute.GET(req("GET", undefined, "http://x/api?after=zzz"), ctx({ id: p.id }))).status).toBe(400);
    expect((await nextRoute.GET(req("GET", undefined, `http://x/api?episode=zzz`), ctx({ id: p.id }))).status).toBe(400);
  });
});

describe("moderation and sharing limits", () => {
  it("only server admins reach the moderation list, and admins delete public playlists only", async () => {
    const { owner, server, friend } = await world();
    const pub = await makePlaylist(db, { serverId: server.id, ownerViewerId: friend.viewer.id, visibility: "server", name: "Pub" });
    const priv = await makePlaylist(db, { serverId: server.id, ownerViewerId: friend.viewer.id, name: "Priv" });
    await signInAs(friend.accountId, friend.viewer.id);
    expect((await moderationRoute.GET(req("GET"), ctx({ serverId: server.id }))).status).toBe(404);
    await signInAs(owner.accountId, owner.viewer.id);
    expect((await body(await moderationRoute.GET(req("GET"), ctx({ serverId: server.id })))).playlists.map((p: { name: string }) => p.name)).toEqual(["Pub"]);
    expect((await playlistRoute.DELETE(req("DELETE"), ctx({ id: priv.id }))).status).toBe(404);
    expect((await playlistRoute.DELETE(req("DELETE"), ctx({ id: pub.id }))).status).toBe(200);
  });

  it("answers an identical 404 for share targets that are invalid", async () => {
    const { owner, server } = await world();
    const stranger = await makeAccount(db, "stranger");
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await signInAs(owner.accountId, owner.viewer.id);
    const missing = await membersRoute.POST(req("POST", { viewerId: "00000000-0000-4000-8000-0000000000dd", role: "viewer" }), ctx({ id: p.id }));
    const offServer = await membersRoute.POST(req("POST", { viewerId: stranger.viewer.id, role: "viewer" }), ctx({ id: p.id }));
    expect(missing.status).toBe(404);
    expect(await body(missing)).toEqual(await body(offServer));
    expect(offServer.status).toBe(404);
  });

  it("members can leave but a plain viewer can't edit; a role change needs the owner", async () => {
    const { owner, server, friend } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    await addMember(db, p.id, friend.viewer.id, "viewer", owner.viewer.id);
    await signInAs(friend.accountId, friend.viewer.id);
    expect((await playlistRoute.PATCH(req("PATCH", { name: "Nope" }), ctx({ id: p.id }))).status).toBe(403);
    expect((await membersRoute.PATCH(req("PATCH", { viewerId: friend.viewer.id, role: "editor" }), ctx({ id: p.id }))).status).toBe(403);
    expect((await membersRoute.DELETE(req("DELETE"), ctx({ id: p.id }))).status).toBe(200);
  });
});

describe("for-item lookup and starting a queue", () => {
  it("lists editable playlists for an item with their membership flag, and validates its parameters", async () => {
    const { owner, server, library, friend } = await world();
    const t = await makeTitle(db, library.id, { name: "Pick me" });
    const holds = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id, name: "holds it" });
    const empty = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id, name: "empty" });
    await makePlaylist(db, { serverId: server.id, ownerViewerId: friend.viewer.id, name: "not mine" });
    const item = await addItem(db, holds.id, { titleId: t.id });
    await signInAs(owner.accountId, owner.viewer.id);

    const c = ctx({ serverId: server.id });
    const res = await body(await forItemRoute.GET(req("GET", undefined, `http://x/api?titleId=${t.id}`), c));
    const byName = Object.fromEntries(res.playlists.map((p: { name: string; itemId: string | null }) => [p.name, p.itemId]));
    expect(byName).toEqual({ "holds it": item.id, empty: null });
    expect(empty.id).toBeTruthy();

    expect((await forItemRoute.GET(req("GET"), c)).status).toBe(400); // neither id
    expect((await forItemRoute.GET(req("GET", undefined, `http://x/api?titleId=${t.id}&episodeId=${t.id}`), c)).status).toBe(400); // both
    expect((await forItemRoute.GET(req("GET", undefined, "http://x/api?titleId=nope"), c)).status).toBe(400);
    const missing = "http://x/api?titleId=00000000-0000-4000-8000-0000000000ef";
    expect((await forItemRoute.GET(req("GET", undefined, missing), c)).status).toBe(404);
  });

  it("returns the first playable item when `after` is omitted", async () => {
    const { owner, server, library } = await world();
    const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const m = await makeTitle(db, library.id);
    const first = await addItem(db, p.id, { titleId: m.id });
    await signInAs(owner.accountId, owner.viewer.id);
    const res = await body(await nextRoute.GET(req("GET"), ctx({ id: p.id })));
    expect(res.next).toMatchObject({ kind: "movie", id: m.id, itemId: first.id });
    const empty = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    expect(await body(await nextRoute.GET(req("GET"), ctx({ id: empty.id })))).toEqual({ next: null });
  });
});
