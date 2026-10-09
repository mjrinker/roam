/** POST /api/download/bulk: download choices for a selection, behind the same gate as playing. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));

import { mediaFiles, profiles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { POST } from "./bulk/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}
const ask = (body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const file = (ownerKind: "title" | "episode", ownerId: string, over: Partial<typeof mediaFiles.$inferInsert> = {}) =>
  db.insert(mediaFiles).values({ ownerKind, ownerId, partIndex: 0, boxFileId: `b${Math.random()}`, filename: "f.mp4", container: "mp4", probeStatus: "ok", durationSeconds: 100, sizeBytes: 1000, width: 1280, height: 720, ...over });

async function world() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  await signInAs(me.accountId);
  return { server };
}

describe("bulk download choices", () => {
  it("gives a movie and an audiobook one item each, and a show all of its episodes that have files, in order", async () => {
    const w = await world();
    const movies = await makeLibrary(db, w.server.id, "movies", "everyone");
    const film = await makeTitle(db, movies.id, { kind: "movie", name: "Film" });
    await file("title", film.id, { versionLabel: "720p" });
    await file("title", film.id, { versionLabel: "480p", width: 854, height: 480, sizeBytes: 400 });
    const books = await makeLibrary(db, w.server.id, "audiobooks", "everyone");
    const book = await makeTitle(db, books.id, { kind: "audiobook", name: "Book" });
    await file("title", book.id, { width: null, height: null });
    const shows = await makeLibrary(db, w.server.id, "shows", "everyone");
    const { show, episodes } = await makeShow(db, shows.id, 3, { name: "Show" });
    await file("episode", episodes[0].id);
    await file("episode", episodes[2].id); // the second episode has no file yet
    const res = await ask({ titleIds: [show.id, film.id, book.id] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(0);
    expect(body.items.map((i: { title: string; subtitle: string | null; kind: string }) => [i.kind, i.title])).toEqual([["watch", "Show"], ["watch", "Show"], ["watch", "Film"], ["listen", "Book"]]);
    expect(body.items[0].subtitle).toMatch(/E1/);
    expect(body.items[1].subtitle).toMatch(/E3/);
    expect(body.items[2].options.map((o: { label: string }) => o.label)).toEqual(["720p", "480p"]);
  });
  it("counts what can't be downloaded (hidden, another server, no files, not a title) as skipped without naming it", async () => {
    const other = await world(); // another server, set up first so the profile below is the one signed in
    const theirsLib = await makeLibrary(db, other.server.id, "movies", "everyone");
    const theirs = await makeTitle(db, theirsLib.id, { kind: "movie" });
    await file("title", theirs.id);
    const w = await world();
    const hiddenLib = await makeLibrary(db, w.server.id, "movies", "restricted");
    const hidden = await makeTitle(db, hiddenLib.id, { kind: "movie" });
    await file("title", hidden.id);
    const open = await makeLibrary(db, w.server.id, "movies", "everyone");
    const empty = await makeTitle(db, open.id, { kind: "movie" });
    const fine = await makeTitle(db, open.id, { kind: "movie", name: "Fine" });
    await file("title", fine.id);
    void empty;
    const res = await ask({ titleIds: [hidden.id, empty.id, fine.id, theirs.id, "00000000-0000-4000-8000-0000000000aa"] });
    const body = await res.json();
    expect(body.items.map((i: { title: string }) => i.title)).toEqual(["Fine"]);
    expect(body.skipped).toBe(4);
  });
  it("refuses a bad request and a visitor who isn't signed in", async () => {
    await world();
    for (const bad of [{}, { titleIds: [] }, { titleIds: ["nope"] }, { titleIds: Array.from({ length: 301 }, () => "00000000-0000-4000-8000-0000000000aa") }]) {
      expect((await ask(bad)).status, JSON.stringify(bad).slice(0, 30)).toBe(400);
    }
    h.resolution = null;
    expect((await ask({ titleIds: ["00000000-0000-4000-8000-0000000000aa"] })).status).toBe(401);
  });
});
