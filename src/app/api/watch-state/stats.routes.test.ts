/** Progress saves feed the household's watch statistics, and nothing else does. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { profiles, viewers, watchActivity, watchState } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { PATCH } from "./route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

async function signInAs(accountId: string, viewerIndex = 0) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[viewerIndex], viewers: all };
}
const save = (body: unknown) => PATCH(new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
/** Pretends the last save was `seconds` ago. */
const ago = (viewerId: string, ownerId: string, seconds: number) => db.update(watchState).set({ updatedAt: new Date(Date.now() - seconds * 1000) }).where(and(eq(watchState.viewerId, viewerId), eq(watchState.ownerId, ownerId)));
const timeOf = async (accountId: string, titleId: string) => (await db.select().from(watchActivity).where(and(eq(watchActivity.accountId, accountId), eq(watchActivity.titleId, titleId)))).reduce((n, r) => n + r.seconds, 0);

async function world() {
  const admin = await makeAccount(db, "sradmin");
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, "srme");
  await joinServer(db, server.id, me.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const music = await makeLibrary(db, server.id, "music", "everyone");
  await signInAs(me.accountId);
  return { server, me, movies, shows, music };
}

describe("PATCH /api/watch-state and the statistics", () => {
  it("counts the time between saves for the household, nothing for the first save", async () => {
    const w = await world();
    const film = await makeTitle(db, w.movies.id, { kind: "movie", name: "Film" }, { files: true });
    expect((await save({ ownerKind: "title", ownerId: film.id, positionSeconds: 100, durationSeconds: 6000 })).status).toBe(200);
    expect(await timeOf(w.me.accountId, film.id)).toBe(0);
    await ago(w.me.viewer.id, film.id, 15);
    await save({ ownerKind: "title", ownerId: film.id, positionSeconds: 115, durationSeconds: 6000 });
    expect(await timeOf(w.me.accountId, film.id)).toBe(15);
    await ago(w.me.viewer.id, film.id, 15);
    await save({ ownerKind: "title", ownerId: film.id, positionSeconds: 3000, durationSeconds: 6000 }); // a jump ahead counts only what could have been watched
    expect(await timeOf(w.me.accountId, film.id)).toBe(15 + 60);
    await ago(w.me.viewer.id, film.id, 15);
    await save({ ownerKind: "title", ownerId: film.id, positionSeconds: 10, durationSeconds: 6000 }); // going back counts nothing
    expect(await timeOf(w.me.accountId, film.id)).toBe(75);
  });

  it("counts an episode for its show, and keeps a household's profiles together", async () => {
    const w = await world();
    const { show, episodes } = await makeShow(db, w.shows.id, 2, { name: "Show" }, { files: true });
    // a second profile in the same household
    await db.insert(viewers).values({ accountId: w.me.accountId, name: "Kid", role: "limited", avatarKey: "a1" } as never).onConflictDoNothing();
    for (const [index, ep] of [[0, episodes[0]], [1, episodes[1]]] as const) {
      await signInAs(w.me.accountId, index);
      const viewerId = (h.resolution as { viewer: { id: string } }).viewer.id;
      await save({ ownerKind: "episode", ownerId: ep.id, positionSeconds: 50, durationSeconds: 1500 });
      await ago(viewerId, ep.id, 20);
      await save({ ownerKind: "episode", ownerId: ep.id, positionSeconds: 70, durationSeconds: 1500 });
    }
    expect(await timeOf(w.me.accountId, show.id)).toBeGreaterThanOrEqual(20);
    const rows = await db.select().from(watchActivity).where(eq(watchActivity.titleId, show.id));
    expect(rows.every((r) => r.accountId === w.me.accountId)).toBe(true);
    expect(Object.keys(rows[0]).sort()).toEqual(["accountId", "day", "seconds", "serverId", "titleId"]); // there is nowhere to say which profile
  });

  it("records nothing for songs, which are not remembered, and marking as watched adds no time", async () => {
    const w = await world();
    const song = await makeTitle(db, w.music.id, { kind: "audiobook", name: "Song" }, { files: true });
    await save({ ownerKind: "title", ownerId: song.id, positionSeconds: 10, durationSeconds: 200 });
    await save({ ownerKind: "title", ownerId: song.id, positionSeconds: 40, durationSeconds: 200 });
    expect(await db.select().from(watchActivity).where(eq(watchActivity.titleId, song.id))).toEqual([]);
  });
});
