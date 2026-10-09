/** The play and audiobook manifests carry the library's default speed, for the player to start at. */
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

import { libraries, profiles, viewers } from "@/lib/db/schema";
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
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const books = await makeLibrary(db, server.id, "audiobooks", "everyone");
  return { movies, books, film: await makeTitle(db, movies.id, { kind: "movie" }), book: await makeTitle(db, books.id, { kind: "audiobook" }) };
}
const playCtx = (id: string) => ({ params: Promise.resolve({ ownerKind: "title", ownerId: id }) }) as never;
const bookCtx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

describe("the manifests' defaultRate", () => {
  it("is null for a library with no default, and the library's speed once one is set", async () => {
    const w = await world();
    expect((await (await play(new Request("http://x"), playCtx(w.film.id))).json()).defaultRate).toBeNull();
    expect((await (await bookManifest(new Request("http://x"), bookCtx(w.book.id))).json()).defaultRate).toBeNull();
    await db.update(libraries).set({ defaultPlaybackSpeed: 1.5 }).where(eq(libraries.id, w.movies.id));
    await db.update(libraries).set({ defaultPlaybackSpeed: 2.25 }).where(eq(libraries.id, w.books.id));
    expect((await (await play(new Request("http://x"), playCtx(w.film.id))).json()).defaultRate).toBe(1.5);
    expect((await (await bookManifest(new Request("http://x"), bookCtx(w.book.id))).json()).defaultRate).toBe(2.25);
  });
  it("ignores a stored value that is not an allowed speed", async () => {
    const w = await world();
    await db.update(libraries).set({ defaultPlaybackSpeed: 9 }).where(eq(libraries.id, w.movies.id));
    expect((await (await play(new Request("http://x"), playCtx(w.film.id))).json()).defaultRate).toBeNull();
  });
});
