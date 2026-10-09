/** GET /api/download/[ownerKind]/[ownerId]/options: the versions on offer with their sizes, behind the same gate as playing. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { mediaFiles, profiles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { GET } from "./[ownerKind]/[ownerId]/options/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}
const ask = (kind: string, id: string) => GET(new Request("http://x"), { params: Promise.resolve({ ownerKind: kind, ownerId: id }) } as never);
const file = (ownerKind: "title" | "episode", ownerId: string, over: Partial<typeof mediaFiles.$inferInsert>) =>
  db.insert(mediaFiles).values({ ownerKind, ownerId, partIndex: 0, boxFileId: `b${Math.random()}`, filename: "f.mp4", container: "mp4", probeStatus: "ok", durationSeconds: 100, ...over });

async function world() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  await signInAs(me.accountId);
  return { server, owner, me };
}

describe("the download options", () => {
  it("lists each version of a movie, best first, with its resolution name and total size (parts added up, each file once)", async () => {
    const w = await world();
    const lib = await makeLibrary(db, w.server.id, "movies", "everyone");
    const film = await makeTitle(db, lib.id, { kind: "movie", name: "The Film", year: 2020 });
    await file("title", film.id, { versionLabel: "4k", boxFileId: "k1", sizeBytes: 3_000_000_000, width: 3840, height: 2160 });
    await file("title", film.id, { versionLabel: "4k", partIndex: 1, boxFileId: "k2", sizeBytes: 1_000_000_000, width: 3840, height: 2160 });
    await file("title", film.id, { versionLabel: "720p", boxFileId: "s1", sizeBytes: 500_000_000, width: 1280, height: 720 });
    const res = await ask("title", film.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ kind: "watch", title: "The Film", subtitle: "2020" });
    expect(body.options).toEqual([
      { label: "4k", name: "4K", height: 2160, sizeBytes: 4_000_000_000, parts: 2 },
      { label: "720p", name: "720p", height: 720, sizeBytes: 500_000_000, parts: 1 },
    ]);
  });
  it("has no size when a file's size isn't known, and leaves out a version that isn't probed yet", async () => {
    const w = await world();
    const lib = await makeLibrary(db, w.server.id, "movies", "everyone");
    const film = await makeTitle(db, lib.id, { kind: "movie" });
    await file("title", film.id, { versionLabel: "1080p", sizeBytes: null, width: 1920, height: 1080 });
    await file("title", film.id, { versionLabel: "4k", probeStatus: "pending", durationSeconds: null, sizeBytes: 9, width: 3840, height: 2160 });
    const body = await (await ask("title", film.id)).json();
    expect(body.options.map((o: { label: string; sizeBytes: number | null }) => [o.label, o.sizeBytes])).toEqual([["1080p", null]]);
  });
  it("describes an episode by its show and number, and an audiobook as a single audio download", async () => {
    const w = await world();
    const shows = await makeLibrary(db, w.server.id, "shows", "everyone");
    const { episodes } = await makeShow(db, shows.id, 2, { name: "Show" });
    await file("episode", episodes[1].id, { sizeBytes: 700, width: 1280, height: 720 });
    const ep = await (await ask("episode", episodes[1].id)).json();
    expect(ep).toMatchObject({ kind: "watch", title: "Show" });
    expect(ep.subtitle).toMatch(/^S1 · E2/);
    const books = await makeLibrary(db, w.server.id, "audiobooks", "everyone");
    const book = await makeTitle(db, books.id, { kind: "audiobook", name: "A Book" });
    await file("title", book.id, { sizeBytes: 100, boxFileId: "a1" });
    await file("title", book.id, { sizeBytes: 50, partIndex: 1, boxFileId: "a2" });
    const audio = await (await ask("title", book.id)).json();
    expect(audio).toMatchObject({ kind: "listen", title: "A Book" });
    expect(audio.options).toEqual([{ label: "", name: "Audio", height: null, sizeBytes: 150, parts: 2 }]);
  });
  it("is the same 404 for things the profile can't see, an item with no files, and bad ids; 403 for another server", async () => {
    const w = await world();
    const hidden = await makeLibrary(db, w.server.id, "movies", "restricted");
    const secret = await makeTitle(db, hidden.id, { kind: "movie" });
    await file("title", secret.id, { sizeBytes: 1 });
    expect((await ask("title", secret.id)).status).toBe(404);
    const open = await makeLibrary(db, w.server.id, "movies", "everyone");
    const empty = await makeTitle(db, open.id, { kind: "movie" });
    expect((await ask("title", empty.id)).status).toBe(404);
    for (const [k, id] of [["title", "nope"], ["show", empty.id], ["title", "00000000-0000-4000-8000-0000000000aa"]]) expect((await ask(k, id)).status, `${k} ${id}`).toBe(404);
    const other = await world();
    const theirs = await makeLibrary(db, other.server.id, "movies", "everyone");
    const film = await makeTitle(db, theirs.id, { kind: "movie" });
    await file("title", film.id, { sizeBytes: 1 });
    await signInAs(w.me.accountId);
    expect((await ask("title", film.id)).status).toBe(403);
  });
});
