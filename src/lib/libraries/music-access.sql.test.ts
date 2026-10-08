/** A music library obeys the same access and age rules as everything else: restricted libraries and rated libraries hide their files. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { libraries, libraryMembers, titles } from "@/lib/db/schema";
import { GLOBALLY_LISTED_LIBRARY_KINDS } from "./profile";
import { listFolder } from "./folder-browse";
import { setVideoLibraryRating } from "./video-rating";
import type { LibraryActor } from "@/lib/content/library-access";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const adult = { locale: "en-US", maxAge: null, allowUnrated: true };
const kid = { locale: "en-US", maxAge: 7, allowUnrated: false };

async function world(access: "everyone" | "restricted") {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const library = await makeLibrary(db, server.id, "music", access);
  const t = await makeTitle(db, library.id, { kind: "audiobook", name: "Episode", folderPath: "Podcasts", boxFolderId: `file:${Math.random()}`, authors: ["Host"] });
  const actor = (a: { accountId: string }, isAdmin = false): LibraryActor => ({ serverId: server.id, accountId: a.accountId, isAdmin });
  return { admin, member, server, library, t, actor };
}

describe("music libraries and access", () => {
  it("lists songs with their artist, one folder level at a time", async () => {
    const w = await world("everyone");
    const root = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "" });
    expect(root?.folders).toEqual(["Podcasts"]);
    const page = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "Podcasts" });
    expect(page?.items.map((i) => [i.name, i.authors])).toEqual([["Episode", ["Host"]]]);
  });

  it("hides a restricted music library from an ungranted account, shows it to a granted one and the admin", async () => {
    const w = await world("restricted");
    expect(await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "" })).toBeNull();
    await db.insert(libraryMembers).values({ libraryId: w.library.id, serverId: w.server.id, accountId: w.member.accountId });
    expect((await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "Podcasts" }))?.items).toHaveLength(1);
    await db.delete(libraryMembers).where(eq(libraryMembers.libraryId, w.library.id));
    expect(await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "" })).toBeNull();
    expect((await listFolder(db, { actor: w.actor(w.admin, true), viewer: adult, libraryId: w.library.id, path: "Podcasts" }))?.items).toHaveLength(1);
  });

  it("applies the library rating: an adults-only music library is invisible to an age-limited profile, and re-rating takes effect at once", async () => {
    const w = await world("everyone");
    expect(await setVideoLibraryRating(db, w.library.id, 18)).toEqual({ ok: true });
    expect(await listFolder(db, { actor: w.actor(w.member), viewer: kid, libraryId: w.library.id, path: "Podcasts" })).toBeNull();
    expect((await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "Podcasts" }))?.items).toHaveLength(1);
    expect(await setVideoLibraryRating(db, w.library.id, 0)).toEqual({ ok: true });
    expect((await listFolder(db, { actor: w.actor(w.member), viewer: kid, libraryId: w.library.id, path: "Podcasts" }))?.items).toHaveLength(1);
    const [row] = await db.select().from(titles).where(eq(titles.id, w.t.id));
    expect(row.ratingAges).toEqual({ ANY: 0 });
    const [lib] = await db.select().from(libraries).where(eq(libraries.id, w.library.id));
    expect(lib.ratingAges).toEqual({ ANY: 0 });
  });
});

describe("music in global lists", () => {
  it("stays out of search and recently-added until there is an album-level view (a song is a title each)", () => {
    expect(GLOBALLY_LISTED_LIBRARY_KINDS).not.toContain("music");
  });
});
