/**
 * A photo title must be refused everywhere that assumes something plays: the play manifest, progress,
 * the audiobook player, artwork-by-title, playlists, search, resync and remux. These tests put a photo
 * in the database BEFORE any code can create one, and check each path answers "not found" (or leaves it
 * out) and never reaches Box.
 */
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
  createBoxProviderForServer: () =>
    new Proxy({}, { get: (_t, name) => (typeof name === "symbol" || name === "then" ? undefined : () => (h.boxCalls.push(String(name)), Promise.reject(new Error("Box must not be called")))) }),
}));

import { playlistItems, profiles, viewers } from "@/lib/db/schema";
import { findAddableTarget, listVisibleItems } from "@/lib/playlists/items";
import { nextAfter } from "@/lib/playlists/next";
import { copyPlaylist } from "@/lib/playlists/service";
import { resolveRemuxScope } from "@/lib/remux/remux-pass";
import { addItem, joinServer, makeAccount, makeLibrary, makePlaylist, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { GET as playRoute } from "../play/[ownerKind]/[ownerId]/route";
import { GET as watchGet, PATCH as watchPatch } from "../watch-state/route";
import { GET as bookManifest } from "../audiobooks/[id]/manifest/route";
import { GET as bookSegment } from "../audiobooks/[id]/segments/[index]/route";
import { GET as artworkRoute } from "./[id]/artwork/route";
import { GET as searchRoute } from "../search/route";

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
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;

async function world() {
  const owner = await makeAccount(db, "owner");
  const server = await makeServer(db, owner.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const photos = await makeLibrary(db, server.id, "photos", "everyone");
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const photo = await makeTitle(db, photos.id, { kind: "photo", name: "Beach Photo", boxFolderId: `file:${Math.random()}` });
  const clip = await makeTitle(db, photos.id, { kind: "movie", name: "Beach Clip", boxFolderId: `file:${Math.random()}` });
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "Beach Film" });
  await signInAs(member.accountId, member.viewer.id);
  return { owner, server, member, photos, movies, photo, clip, film };
}

describe("play, progress and audio routes refuse a photo", () => {
  it("answers the same 404 as a missing title, and never calls Box", async () => {
    const w = await world();
    const missing = "00000000-0000-4000-8000-0000000000aa";
    const patchBody = (id: string) => new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerKind: "title", ownerId: id, positionSeconds: 5, durationSeconds: 100, finished: false }) });
    const outcomes = async (id: string) => [
      (await playRoute(new Request("http://x"), ctx({ ownerKind: "title", ownerId: id }))).status,
      (await watchGet(new Request(`http://x/api/watch-state?ownerKind=title&ownerId=${id}`))).status,
      (await watchPatch(patchBody(id))).status,
      (await bookManifest(new Request("http://x"), ctx({ id }))).status,
      (await bookSegment(new Request("http://x"), ctx({ id, index: "0" }))).status,
      (await artworkRoute(new Request("http://x"), ctx({ id }))).status,
    ];
    expect(await outcomes(w.photo.id)).toEqual(await outcomes(missing));
    expect(await outcomes(w.photo.id)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(h.boxCalls).toEqual([]);
    // No junk progress row was created.
    const rows = await db.query.watchState.findMany();
    expect(rows.filter((r) => r.ownerId === w.photo.id)).toHaveLength(0);
  });

  it("still serves a video that merely lives in a photo library, and ordinary movies", async () => {
    const w = await world();
    for (const id of [w.clip.id, w.film.id]) {
      const auth = await authorizeOwner("title", id);
      expect(auth.ok, id).toBe(true);
    }
  });

  it("authorizeOwner takes an explicit list: a photo route can ask for photos, and nothing else changes", async () => {
    const w = await world();
    expect((await authorizeOwner("title", w.photo.id)).ok).toBe(false);
    expect((await authorizeOwner("title", w.photo.id, { titleKinds: ["photo"] })).ok).toBe(true);
    expect((await authorizeOwner("title", w.film.id, { titleKinds: ["photo"] })).ok).toBe(false);
  });
});

describe("playlists never hold or surface a photo", () => {
  it("can't add one, and a stale photo entry is skipped by lists, counts, next-up and copies", async () => {
    const w = await world();
    const lib = { serverId: w.server.id, accountId: w.member.accountId, isAdmin: false };
    const viewer = { locale: "en-US", maxAge: null, allowUnrated: true };
    expect(await findAddableTarget(db, { lib, viewer, titleId: w.photo.id })).toBeNull();
    expect(await findAddableTarget(db, { lib, viewer, titleId: w.film.id })).toEqual({ titleId: w.film.id });

    // A stale photo entry, inserted directly (as if it predated this rule), between two real ones.
    const playlist = await makePlaylist(db, { serverId: w.server.id, ownerViewerId: w.member.viewer.id });
    const a = await addItem(db, playlist.id, { titleId: w.film.id }, 1024);
    await db.insert(playlistItems).values({ playlistId: playlist.id, titleId: w.photo.id, position: 2048 });
    const b = await addItem(db, playlist.id, { titleId: w.clip.id }, 3072);
    const page = await listVisibleItems(db, { playlistId: playlist.id, lib, viewer });
    expect(page.items.map((i) => i.id)).toEqual([a.id, b.id]);
    const next = await nextAfter(db, { playlistId: playlist.id, viewerId: w.member.viewer.id, afterItemId: a.id });
    expect(next.ok && next.value?.itemId).toBe(b.id); // jumps over the photo
    const copy = await copyPlaylist(db, { playlistId: playlist.id, viewerId: w.member.viewer.id });
    expect(copy.ok && copy.value.itemsCopied).toBe(2);
  });
});

describe("search leaves photo libraries out", () => {
  it("finds the film but neither the photo nor a video inside the photo library", async () => {
    const w = await world();
    const res = await searchRoute(new Request(`http://x/api/search?serverId=${w.server.id}&q=Beach`));
    const names = ((await res.json()).results as { name: string }[]).map((r) => r.name).sort();
    expect(names).toEqual(["Beach Film"]);
  });
});

describe("remux never targets a photo", () => {
  it("has no scope for a photo title, but does for a movie", async () => {
    const w = await world();
    expect(await resolveRemuxScope(w.photo.id)).toBeNull();
    expect((await resolveRemuxScope(w.film.id))?.ownerKind).toBe("title");
  });
});
