/** A movie's trailers and other extras: found by Plex's naming, kept in step on rescans, and playable through the usual routes. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/storage/box", () => ({
  createBoxProviderForServer: () => ({ getStreamingUrl: async (id: string) => ({ url: `https://box/${id}`, expiresAt: new Date(Date.now() + 60_000) }) }),
}));
vi.mock("@/lib/auth/guards", () => ({ getCurrentServerMember: async () => null }));

import { libraries, mediaFiles, titleExtras } from "@/lib/db/schema";
import { resolveOwner } from "@/lib/auth/resolve-server";
import { loadExtraForWatch, loadTitleExtras } from "@/lib/extras/load";
import { joinServer } from "@/lib/playlists/test-db";
import { buildPlayManifest } from "@/lib/player/manifest";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import type { StorageEntry } from "@/lib/storage/provider";
import { findExtras, syncTitleExtras } from "./title-extras";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const file = (id: string, name: string, size = 5_000_000): StorageEntry => ({ id, name, kind: "file", sizeBytes: size }) as StorageEntry;
const folder = (id: string, name: string): StorageEntry => ({ id, name, kind: "folder" }) as StorageEntry;
const provider = (listings: Record<string, StorageEntry[] | Error>) => ({
  listFolder: async (id: string) => {
    const l = listings[id];
    if (l instanceof Error) throw l;
    return l ?? [];
  },
});

async function movie() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, lib.id, { kind: "movie", ratingAges: { ANY: 0 } });
  return { owner, server, lib, film };
}
const extrasOf = (titleId: string) => db.select().from(titleExtras).where(eq(titleExtras.titleId, titleId));
const filesOf = (ownerId: string) => db.select().from(mediaFiles).where(and(eq(mediaFiles.ownerKind, "extra"), eq(mediaFiles.ownerId, ownerId)));

describe("finding extras in a movie folder", () => {
  it("takes suffixed files and the videos in type-named subfolders, and nothing else", async () => {
    const children = [
      file("m", "Film (2020).mp4"),
      file("t", "Teaser-trailer.mp4"),
      file("v", "Variant-trailer.aac.mp4"), // a remuxed copy, not a separate extra
      file("txt", "Notes-trailer.txt"),
      file("stub", "Stub-trailer.mov", 90), // a 90-byte QuickTime reference stub, not a video
      folder("f1", "Behind The Scenes"),
      folder("f2", "Subs"),
      folder("f3", "Trailers"),
    ];
    const { found, complete } = await findExtras(
      provider({ f1: [file("b1", "Making Of.mp4"), file("b2", "readme.txt")], f2: [file("s1", "Film.en.mp4")], f3: [file("t", "Teaser-trailer.mp4"), file("t2", "Second.mp4")] }),
      children
    );
    expect(complete).toBe(true);
    expect(found.map((f) => [f.category, f.name, f.entry.id])).toEqual([
      ["behindthescenes", "Making Of", "b1"],
      ["trailers", "Second", "t2"],
      ["trailers", "Teaser", "t"], // listed in both places, found once
    ]);
  });
  it("says it is incomplete when a subfolder can't be listed", async () => {
    const { found, complete } = await findExtras(provider({ f1: new Error("boom") }), [folder("f1", "Trailers"), file("t", "A-trailer.mp4")]);
    expect([complete, found.map((f) => f.entry.id)]).toEqual([false, ["t"]]);
  });
});

describe("keeping a movie's extras in step with its folder", () => {
  it("adds, renames and removes them, with their files, and leaves them alone when the listing was incomplete", async () => {
    const { film } = await movie();
    const found = async (children: StorageEntry[], listings = {}) => (await findExtras(provider(listings), children)).found;
    await syncTitleExtras(film.id, await found([file("t", "One-trailer.mp4", 10_000_000), file("s", "Opening-scene.mp4", 20_000_000)]));
    let rows = await extrasOf(film.id);
    expect(rows.map((r) => [r.category, r.name]).sort()).toEqual([["scenes", "Opening"], ["trailers", "One"]]);
    const trailer = rows.find((r) => r.boxFileId === "t")!;
    expect((await filesOf(trailer.id)).map((f) => [f.boxFileId, f.filename, f.sizeBytes, f.container, f.partIndex, f.versionLabel])).toEqual([["t", "One-trailer.mp4", 10_000_000, "mp4", 0, ""]]);

    // renamed and moved to another type: same row, new name and type
    await syncTitleExtras(film.id, await found([file("t", "Uno-featurette.mp4", 11_000_000), file("s", "Opening-scene.mp4", 20_000_000)]));
    rows = await extrasOf(film.id);
    expect(rows.find((r) => r.boxFileId === "t")).toMatchObject({ id: trailer.id, category: "featurettes", name: "Uno" });
    expect((await filesOf(trailer.id))[0]).toMatchObject({ filename: "Uno-featurette.mp4", sizeBytes: 11_000_000 });

    // an incomplete listing never removes anything
    await syncTitleExtras(film.id, [], false);
    expect(await extrasOf(film.id)).toHaveLength(2);

    // a complete listing without the scene removes it and its file
    const scene = rows.find((r) => r.boxFileId === "s")!;
    await syncTitleExtras(film.id, await found([file("t", "Uno-featurette.mp4", 11_000_000)]));
    expect((await extrasOf(film.id)).map((r) => r.boxFileId)).toEqual(["t"]);
    expect(await filesOf(scene.id)).toEqual([]);
    await syncTitleExtras(film.id, []);
    expect(await extrasOf(film.id)).toEqual([]);
    expect(await filesOf(trailer.id)).toEqual([]);
  });
  it("never touches another movie's extras", async () => {
    const a = await movie();
    const b = await makeTitle(db, a.lib.id, { kind: "movie" });
    await syncTitleExtras(a.film.id, (await findExtras(provider({}), [file("same", "X-trailer.mp4")])).found);
    await syncTitleExtras(b.id, (await findExtras(provider({}), [file("same", "X-trailer.mp4")])).found);
    await syncTitleExtras(b.id, []);
    expect(await extrasOf(a.film.id)).toHaveLength(1);
    expect(await extrasOf(b.id)).toEqual([]);
  });
});

describe("showing and playing extras", () => {
  it("lists only the ones that are ready, grouped in the usual order, A to Z", async () => {
    const { film } = await movie();
    await syncTitleExtras(film.id, (await findExtras(provider({}), [file("1", "Zed-trailer.mp4"), file("2", "Alpha-trailer.mp4"), file("3", "Chat-interview.mp4"), file("4", "Notready-short.mp4")])).found);
    for (const [boxId, seconds] of [["1", 60], ["2", 90], ["3", 300]] as const) await db.update(mediaFiles).set({ durationSeconds: seconds, probeStatus: "ok" }).where(and(eq(mediaFiles.ownerKind, "extra"), eq(mediaFiles.boxFileId, boxId)));
    const groups = await loadTitleExtras(db, film.id);
    expect(groups.map((g) => [g.category, g.items.map((i) => [i.name, i.durationSeconds])])).toEqual([
      ["trailers", [["Alpha", 90], ["Zed", 60]]],
      ["interviews", [["Chat", 300]]],
    ]);
    expect(await loadTitleExtras(db, (await makeTitle(db, (await movie()).lib.id, { kind: "movie" })).id)).toEqual([]);
  });
  it("leaves out an extra in a format browsers can't play, but keeps it recorded", async () => {
    const { film } = await movie();
    await syncTitleExtras(film.id, (await findExtras(provider({}), [file("a", "Good-trailer.mp4"), file("b", "Old-trailer.mov"), file("c", "OldSound-trailer.mov")])).found);
    const codecs: Record<string, [string | null, string | null]> = { a: ["avc1", "mp4a"], b: ["svq3", "qdm2"], c: ["avc1", "qdm2"] };
    for (const [id, [v, a]] of Object.entries(codecs)) await db.update(mediaFiles).set({ durationSeconds: 60, probeStatus: "ok", videoCodec: v, audioCodec: a }).where(and(eq(mediaFiles.ownerKind, "extra"), eq(mediaFiles.boxFileId, id)));
    expect((await loadTitleExtras(db, film.id)).flatMap((g) => g.items.map((i) => i.name))).toEqual(["Good"]);
    expect(await extrasOf(film.id)).toHaveLength(3);
  });
  it("loads an extra for the watch page for someone who can see its library, and not for anyone else", async () => {
    const { film, server, lib } = await movie();
    await syncTitleExtras(film.id, (await findExtras(provider({}), [file("w", "Teaser-trailer.mp4")])).found);
    const [extra] = await extrasOf(film.id);
    const member = await makeAccount(db, "viewer");
    await joinServer(db, server.id, member.accountId);
    const actor = { serverId: server.id, accountId: member.accountId, isAdmin: false };
    expect(await loadExtraForWatch(db, actor, extra.id)).toMatchObject({ extra: { id: extra.id, name: "Teaser" }, movie: { id: film.id } });
    const other = await movie();
    expect(await loadExtraForWatch(db, { ...actor, serverId: other.server.id }, extra.id)).toBeNull(); // another server's actor
    await db.update(libraries).set({ access: "restricted" }).where(eq(libraries.id, lib.id));
    expect(await loadExtraForWatch(db, actor, extra.id)).toBeNull();
    expect(await loadExtraForWatch(db, { ...actor, isAdmin: true }, extra.id)).not.toBeNull();
    expect(await loadExtraForWatch(db, actor, film.id)).toBeNull(); // a movie id isn't an extra id
  });
  it("is owned by its movie for access, and plays through the play manifest without ever resuming", async () => {
    const { film, server, owner } = await movie();
    await syncTitleExtras(film.id, (await findExtras(provider({}), [file("x", "Teaser-trailer.mp4")])).found);
    await db.update(mediaFiles).set({ durationSeconds: 75, probeStatus: "ok" }).where(and(eq(mediaFiles.ownerKind, "extra"), eq(mediaFiles.boxFileId, "x")));
    const [extra] = await extrasOf(film.id);
    expect(await resolveOwner("extra", extra.id)).toMatchObject({ serverId: server.id, titleKind: "movie", ratingAges: { ANY: 0 } });
    expect(await resolveOwner("extra", film.id)).toBeNull(); // a movie id isn't an extra id
    const r = await buildPlayManifest("extra", extra.id, owner.viewer.id, server.id);
    expect(r.ok && [r.manifest.ownerKind, r.manifest.durationSeconds, r.manifest.resumeSeconds, r.manifest.segments.map((s) => s.url)]).toEqual(["extra", 75, 0, ["https://box/x"]]);
  });
});
