/** Screen time: a profile past its daily limit, or in quiet hours, can't start a video; progress saves count toward the day. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/player/manifest", () => ({ buildPlayManifest: async () => ({ ok: true, manifest: { segments: [], durationSeconds: 10 } }) }));

import { profiles, screenTime, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { localClock } from "@/lib/screen-time/rules";
import { GET as play } from "./[ownerKind]/[ownerId]/route";
import { PATCH as save } from "../watch-state/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

async function world(rules: Partial<typeof viewers.$inferInsert>) {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  await db.update(viewers).set({ timeZone: "UTC", ...rules }).where(eq(viewers.id, me.viewer.id));
  const [account] = await db.select().from(profiles).where(eq(profiles.id, me.accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, me.accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "Film" }, { files: true });
  return { me, film };
}
const ctx = (id: string) => ({ params: Promise.resolve({ ownerKind: "title", ownerId: id }) }) as never;
const saveBody = (id: string, positionSeconds: number) => save(new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerKind: "title", ownerId: id, positionSeconds, durationSeconds: 6000 }) }));

describe("playing with screen time rules", () => {
  it("plays a profile with no rules as ever, and tells one with a limit how long it has", async () => {
    const free = await world({});
    const a = await play(new Request("http://x"), ctx(free.film.id));
    expect(a.status).toBe(200);
    expect((await a.json()).screenTime).toBeUndefined();
    const limited = await world({ screenTimeMinutes: 60 });
    const b = await (await play(new Request("http://x"), ctx(limited.film.id))).json();
    expect(b.screenTime).toEqual({ stopInSeconds: 3600 });
  });

  it("refuses with 423 once the day's limit is used up, counted from progress saves", async () => {
    const w = await world({ screenTimeMinutes: 30 });
    await saveBody(w.film.id, 100);
    // pretend 30 minutes were watched today
    const day = localClock(new Date(), "UTC").day;
    await db.insert(screenTime).values({ viewerId: w.me.viewer.id, day, seconds: 1800 }).onConflictDoUpdate({ target: [screenTime.viewerId, screenTime.day], set: { seconds: 1800 } });
    const res = await play(new Request("http://x"), ctx(w.film.id));
    expect(res.status).toBe(423);
    expect(await res.json()).toEqual({ error: "Screen time is up for today.", code: "screen_time" });
  });

  it("refuses in quiet hours, and records nothing for a profile without rules", async () => {
    const now = localClock(new Date(), "UTC").minutes;
    const quiet = await world({ quietFrom: (now + 1440 - 30) % 1440, quietTo: (now + 30) % 1440 });
    const res = await play(new Request("http://x"), ctx(quiet.film.id));
    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe("screen_time");
    const free = await world({});
    await saveBody(free.film.id, 100);
    await saveBody(free.film.id, 110);
    expect(await db.select().from(screenTime).where(eq(screenTime.viewerId, free.me.viewer.id))).toEqual([]);
  });

  it("adds the time between saves to the day for a profile with a limit", async () => {
    const w = await world({ screenTimeMinutes: 120 });
    await saveBody(w.film.id, 100);
    const { watchState } = await import("@/lib/db/schema");
    await db.update(watchState).set({ updatedAt: new Date(Date.now() - 15_000) }).where(and(eq(watchState.viewerId, w.me.viewer.id), eq(watchState.ownerId, w.film.id)));
    await saveBody(w.film.id, 115);
    const [row] = await db.select().from(screenTime).where(eq(screenTime.viewerId, w.me.viewer.id));
    expect(row.seconds).toBe(15);
  });
});
