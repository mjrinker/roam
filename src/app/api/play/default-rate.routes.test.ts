/** The play and audiobook manifests carry this profile's starting speed for the library, for the player to start at. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/player/manifest", () => ({ buildPlayManifest: async () => ({ ok: true, manifest: { segments: [], durationSeconds: 10 } }) }));
vi.mock("@/lib/player/audiobook-manifest", () => ({ buildAudiobookManifest: async () => ({ ok: true, value: { segments: [], durationSeconds: 10 } }) }));

import { profiles, viewerLibrarySpeeds, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { GET as play } from "./[ownerKind]/[ownerId]/route";
import { GET as bookManifest } from "../audiobooks/[id]/manifest/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

async function world() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  const [account] = await db.select().from(profiles).where(eq(profiles.id, me.accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, me.accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
  const signInAs = async (accountId: string) => {
    const [acc] = await db.select().from(profiles).where(eq(profiles.id, accountId));
    const v = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
    h.resolution = { account: acc, viewer: v[0], viewers: v };
    return v[0].id;
  };
  const other = await makeAccount(db, "other");
  await joinServer(db, server.id, other.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const books = await makeLibrary(db, server.id, "audiobooks", "everyone");
  return { me: all[0].id, other, signInAs, mine: me.accountId, movies, books, film: await makeTitle(db, movies.id, { kind: "movie" }), book: await makeTitle(db, books.id, { kind: "audiobook" }) };
}
const playCtx = (id: string) => ({ params: Promise.resolve({ ownerKind: "title", ownerId: id }) }) as never;
const bookCtx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

describe("the manifests' defaultRate", () => {
  it("is null with no starting speed, and this profile's own speed once it has set one (with the library, for saving a new one)", async () => {
    const w = await world();
    const first = await (await play(new Request("http://x"), playCtx(w.film.id))).json();
    expect([first.defaultRate, first.libraryId]).toEqual([null, w.movies.id]);
    expect((await (await bookManifest(new Request("http://x"), bookCtx(w.book.id))).json()).defaultRate).toBeNull();
    await db.insert(viewerLibrarySpeeds).values([{ viewerId: w.me, libraryId: w.movies.id, speed: 1.5 }, { viewerId: w.me, libraryId: w.books.id, speed: 2.25 }]);
    expect((await (await play(new Request("http://x"), playCtx(w.film.id))).json()).defaultRate).toBe(1.5);
    const book = await (await bookManifest(new Request("http://x"), bookCtx(w.book.id))).json();
    expect([book.defaultRate, book.libraryId]).toEqual([2.25, w.books.id]);
  });
  it("never shows another profile's speed", async () => {
    const w = await world();
    await db.insert(viewerLibrarySpeeds).values({ viewerId: w.me, libraryId: w.movies.id, speed: 2 });
    await w.signInAs(w.other.accountId);
    expect((await (await play(new Request("http://x"), playCtx(w.film.id))).json()).defaultRate).toBeNull();
  });
  it("ignores a stored value that is not an allowed speed", async () => {
    const w = await world();
    await db.insert(viewerLibrarySpeeds).values({ viewerId: w.me, libraryId: w.movies.id, speed: 9 });
    expect((await (await play(new Request("http://x"), playCtx(w.film.id))).json()).defaultRate).toBeNull();
  });
});
