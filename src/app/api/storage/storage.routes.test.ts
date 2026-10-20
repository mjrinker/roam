/** Admin APIs for storage connections and for adding folders to a library. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { libraries, librarySources, profiles, storageConnections, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { GET as listConnections } from "./connections/route";
import { DELETE as deleteConnection, PATCH as renameConnection } from "./connections/[id]/route";
import { POST as addSource } from "../libraries/[id]/sources/route";
import { DELETE as removeSource } from "../libraries/[id]/sources/[sourceId]/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function world() {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  await signInAs(admin.accountId);
  const box = (await db.insert(storageConnections).values({ id: server.id, serverId: server.id, provider: "box", label: "Box", authStatus: "connected" }).returning())[0];
  const second = (await db.insert(storageConnections).values({ serverId: server.id, provider: "box", label: "Second Box", authStatus: "connected" }).returning())[0];
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  await db.update(libraries).set({ boxFolderId: `root-${server.id}` }).where(eq(libraries.id, lib.id));
  return { admin, member, server, box, second, lib };
}

describe("storage connections", () => {
  it("lists the server's connections with how many libraries use each, to its admin only", async () => {
    const w = await world();
    await db.insert(librarySources).values({ libraryId: w.lib.id, rootId: `cn_${w.second.id}:f1`, label: "On second", position: 1 });
    const res = await listConnections(new Request(`http://x/api/storage/connections?serverId=${w.server.id}`));
    expect(res.status).toBe(200);
    const { connections } = await res.json();
    expect(connections.map((c: { label: string; libraries: number }) => [c.label, c.libraries])).toEqual([["Box", 1], ["Second Box", 1]]);
    expect(JSON.stringify(connections)).not.toMatch(/Encrypted|secret/i);
    await signInAs(w.member.accountId);
    expect((await listConnections(new Request(`http://x/api/storage/connections?serverId=${w.server.id}`))).status).toBe(403);
  });
  it("renames a connection, and removes one only when no library has a folder on it", async () => {
    const w = await world();
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
    const rename = await renameConnection(new Request("http://x", { ...json({ label: "  Family Box " }), method: "PATCH" }), ctx(w.second.id));
    expect(rename.status).toBe(200);
    expect((await db.select().from(storageConnections).where(eq(storageConnections.id, w.second.id)))[0].label).toBe("Family Box");
    expect((await renameConnection(new Request("http://x", { ...json({ label: "" }), method: "PATCH" }), ctx(w.second.id))).status).toBe(400);

    await db.insert(librarySources).values({ libraryId: w.lib.id, rootId: `cn_${w.second.id}:f1`, label: "x", position: 1 });
    const blocked = await deleteConnection(new Request("http://x", { method: "DELETE" }), ctx(w.second.id));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toMatch(/library/i);
    await db.delete(librarySources).where(eq(librarySources.libraryId, w.lib.id));
    expect((await deleteConnection(new Request("http://x", { method: "DELETE" }), ctx(w.second.id))).status).toBe(200);
    // The original connection is used by the library's first folder.
    expect((await deleteConnection(new Request("http://x", { method: "DELETE" }), ctx(w.box.id))).status).toBe(409);
    await signInAs(w.member.accountId);
    expect((await deleteConnection(new Request("http://x", { method: "DELETE" }), ctx(w.box.id))).status).toBe(404);
  });
});

describe("editing files on a connection", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
  const patch = (id: string, body: unknown) => renameConnection(new Request("http://x", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), ctx(id));

  it("is switched on only for a sign-in that was given the permission, and off at any time; Box is always editable", async () => {
    const w = await world();
    const dropbox = (await db.insert(storageConnections).values({ serverId: w.server.id, provider: "dropbox", label: "Dropbox", authStatus: "connected" }).returning())[0];
    const list = async () => ((await (await listConnections(new Request(`http://x/api/storage/connections?serverId=${w.server.id}`))).json()).connections as { id: string; canEdit: boolean; editGranted: boolean }[]).find((c) => c.id === dropbox.id)!;
    expect(await list()).toMatchObject({ canEdit: false, editGranted: false });
    // Without the permission it can't be turned on: the admin is sent to sign in with it.
    const refused = await patch(dropbox.id, { writeEnabled: true });
    expect(refused.status).toBe(409);
    await db.update(storageConnections).set({ writeGranted: true }).where(eq(storageConnections.id, dropbox.id));
    expect(await list()).toMatchObject({ canEdit: false, editGranted: true });
    expect((await patch(dropbox.id, { writeEnabled: true })).status).toBe(200);
    expect(await list()).toMatchObject({ canEdit: true, editGranted: true });
    expect((await patch(dropbox.id, { writeEnabled: false })).status).toBe(200);
    expect(await list()).toMatchObject({ canEdit: false });
    // Box has nothing to switch, and shows as editable.
    expect((await patch(w.box.id, { writeEnabled: true })).status).toBe(400);
    const box = ((await (await listConnections(new Request(`http://x/api/storage/connections?serverId=${w.server.id}`))).json()).connections as { id: string; canEdit: boolean }[]).find((c) => c.id === w.box.id)!;
    expect(box.canEdit).toBe(true);
    // Nothing else may be sent, and only the admin may.
    expect((await patch(dropbox.id, { writeEnabled: true, label: "x" })).status).toBe(400);
    await signInAs(w.member.accountId);
    expect((await patch(dropbox.id, { writeEnabled: false })).status).toBe(404);
  });
});

describe("a library's folders", () => {
  const lctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
  it("adds a folder on another connection, refuses ones already used or on someone else's connection, and removes it again", async () => {
    const w = await world();
    const folderId = `cn_${w.second.id}:folder-1`;
    const ok = await addSource(new Request("http://x", json({ folderId, label: "Dad's movies" })), lctx(w.lib.id));
    expect(ok.status).toBe(200);
    const { source } = await ok.json();
    expect((await db.select().from(librarySources).where(eq(librarySources.libraryId, w.lib.id))).map((s) => [s.rootId, s.label])).toEqual([[folderId, "Dad's movies"]]);

    expect((await addSource(new Request("http://x", json({ folderId, label: "again" })), lctx(w.lib.id))).status).toBe(409); // already a source
    expect((await addSource(new Request("http://x", json({ folderId: `root-${w.server.id}`, label: "first folder" })), lctx(w.lib.id))).status).toBe(409); // the library's own first folder
    const stranger = await makeAccount(db, "other-admin");
    const otherServer = await makeServer(db, stranger.accountId);
    const foreign = await db.insert(storageConnections).values({ serverId: otherServer.id, provider: "box", label: "Theirs" }).returning();
    expect((await addSource(new Request("http://x", json({ folderId: `cn_${foreign[0].id}:x`, label: "theirs" })), lctx(w.lib.id))).status).toBe(409);
    expect((await addSource(new Request("http://x", json({ label: "no folder" })), lctx(w.lib.id))).status).toBe(400);

    const gone = await removeSource(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: w.lib.id, sourceId: source.id }) } as never);
    expect(gone.status).toBe(200);
    expect(await db.select().from(librarySources).where(eq(librarySources.libraryId, w.lib.id))).toEqual([]);
    expect((await removeSource(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: w.lib.id, sourceId: source.id }) } as never)).status).toBe(404);
  });
  it("is for the server's admin only", async () => {
    const w = await world();
    await signInAs(w.member.accountId);
    expect((await addSource(new Request("http://x", json({ folderId: `cn_${w.second.id}:f`, label: "x" })), lctx(w.lib.id))).status).toBe(403);
  });
});
