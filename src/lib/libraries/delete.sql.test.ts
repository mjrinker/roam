/** Deleting a library removes everything of it from Roam, and nothing of anything else. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { libraries, librarySources, mediaFiles, playlistItems, profiles, storageConnections, titleCast, titleExtras, titles, viewers, watchState } from "@/lib/db/schema";
import { DELETE } from "@/app/api/libraries/[id]/route";
import { deleteLibrary } from "./delete";
import { joinServer, makeAccount, makeLibrary, makePlaylist, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}

let n = 0;
const file = (ownerKind: "title" | "episode" | "extra", ownerId: string) =>
  db.insert(mediaFiles).values({ ownerKind, ownerId, partIndex: 0, boxFileId: `f${++n}-${Math.random()}`, filename: "f.mp4", container: "mp4", probeStatus: "ok", durationSeconds: 60 }).returning();

async function populate(serverId: string, accountViewer: string, libraryId: string) {
  const film = await makeTitle(db, libraryId, { kind: "movie", name: "Film" });
  const { show, episodes } = await makeShow(db, libraryId, 2, { name: "Show" });
  const [extra] = await db.insert(titleExtras).values({ titleId: film.id, category: "trailers", name: "Trailer", boxFileId: `x${Math.random()}` }).returning();
  const [filmFile] = await file("title", film.id);
  await file("episode", episodes[0].id);
  await file("episode", episodes[1].id);
  await file("extra", extra.id);
  // a remuxed copy hangs off the film's file
  await db.insert(mediaFiles).values({ variantOfMediaFileId: filmFile.id, boxFileId: `v${Math.random()}`, filename: "f.aac.mp4", container: "mp4" });
  await db.insert(watchState).values([
    { viewerId: accountViewer, ownerKind: "title", ownerId: film.id, positionSeconds: 5 },
    { viewerId: accountViewer, ownerKind: "episode", ownerId: episodes[0].id, positionSeconds: 5 },
  ]);
  await db.insert(titleCast).values({ titleId: film.id, personId: 1, name: "Someone", position: 0 });
  const playlist = await makePlaylist(db, { serverId, ownerViewerId: accountViewer });
  await db.insert(playlistItems).values([{ playlistId: playlist.id, titleId: film.id, position: 0 }, { playlistId: playlist.id, episodeId: episodes[0].id, position: 1 }]);
  await db.insert(librarySources).values({ libraryId, rootId: `cn_x:${Math.random()}`, label: "Extra folder", position: 1 });
  return { film, show, episodes, extra, playlist };
}

describe("deleting a library", () => {
  it("removes its items, their files, watch history, extras, cast, playlist spots and folders, and nothing of another library", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    const lib = await makeLibrary(db, server.id, "movies", "everyone");
    const other = await makeLibrary(db, server.id, "shows", "everyone");
    const [conn] = await db.insert(storageConnections).values({ serverId: server.id, provider: "box", label: "Box" }).returning();
    const mine = await populate(server.id, owner.viewer.id, lib.id);
    const theirs = await populate(server.id, owner.viewer.id, other.id);

    expect((await deleteLibrary(lib.id)).titles).toBe(2);

    expect(await db.select().from(libraries).where(eq(libraries.id, lib.id))).toEqual([]);
    expect(await db.select().from(titles).where(inArray(titles.id, [mine.film.id, mine.show.id]))).toEqual([]);
    expect(await db.select().from(titleExtras).where(eq(titleExtras.id, mine.extra.id))).toEqual([]);
    expect(await db.select().from(titleCast).where(eq(titleCast.titleId, mine.film.id))).toEqual([]);
    expect(await db.select().from(librarySources).where(eq(librarySources.libraryId, lib.id))).toEqual([]);
    expect(await db.select().from(mediaFiles).where(inArray(mediaFiles.ownerId, [mine.film.id, mine.episodes[0].id, mine.episodes[1].id, mine.extra.id]))).toEqual([]);
    expect(await db.select().from(watchState).where(inArray(watchState.ownerId, [mine.film.id, mine.episodes[0].id]))).toEqual([]);
    expect(await db.select().from(playlistItems).where(eq(playlistItems.playlistId, mine.playlist.id))).toEqual([]);

    // the other library is whole, and so is the connection
    expect(await db.select().from(titles).where(inArray(titles.id, [theirs.film.id, theirs.show.id]))).toHaveLength(2);
    expect(await db.select().from(mediaFiles).where(inArray(mediaFiles.ownerId, [theirs.film.id, theirs.episodes[0].id, theirs.extra.id]))).toHaveLength(3);
    expect(await db.select().from(watchState).where(inArray(watchState.ownerId, [theirs.film.id, theirs.episodes[0].id]))).toHaveLength(2);
    expect(await db.select().from(librarySources).where(eq(librarySources.libraryId, other.id))).toHaveLength(1);
    expect(await db.select().from(storageConnections).where(eq(storageConnections.id, conn.id))).toHaveLength(1);
    // the remuxed copy of the deleted film's file is gone, the other's remains
    const variants = await db.select().from(mediaFiles).where(inArray(mediaFiles.filename, ["f.aac.mp4"]));
    expect(variants).toHaveLength(1);
  });

  it("deletes an empty library", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    const lib = await makeLibrary(db, server.id, "audiobooks", "everyone");
    expect((await deleteLibrary(lib.id)).titles).toBe(0);
    expect(await db.select().from(libraries).where(eq(libraries.id, lib.id))).toEqual([]);
  });
});

describe("DELETE /api/libraries/[id]", () => {
  const ask = (id: string, body: unknown) => DELETE(new Request("http://x", { method: "DELETE", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id }) } as never);
  it("needs the library's name, and the server's admin", async () => {
    const admin = await makeAccount(db, "admin");
    const server = await makeServer(db, admin.accountId);
    const member = await makeAccount(db, "member");
    await joinServer(db, server.id, member.accountId);
    const lib = await makeLibrary(db, server.id, "movies", "everyone");
    const [{ name }] = await db.select({ name: libraries.name }).from(libraries).where(eq(libraries.id, lib.id));

    await signInAs(member.accountId);
    expect((await ask(lib.id, { name })).status).toBe(403);
    await signInAs(admin.accountId);
    expect((await ask(lib.id, {})).status).toBe(400);
    expect((await ask(lib.id, { name: "not the name" })).status).toBe(400);
    expect(await db.select().from(libraries).where(eq(libraries.id, lib.id))).toHaveLength(1);
    const ok = await ask(lib.id, { name });
    expect(ok.status).toBe(200);
    expect(await db.select().from(libraries).where(eq(libraries.id, lib.id))).toEqual([]);
    expect((await ask(lib.id, { name })).status).toBe(404);
  });
});
