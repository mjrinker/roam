/** Watching together: who may start and join a room, and that the shared state is what the members last did. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, headers: {} as Record<string, string> }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers(h.headers), cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));

import { eq } from "drizzle-orm";
import { watchRooms } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { MAX_MEMBERS, ROOM_IDLE_MS } from "@/lib/watch-together/service";
import { POST as start } from "./route";
import { POST as look } from "./[id]/route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
});
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};
const post = (body: unknown) => new Request("https://roam.example/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

let n = 0;
async function world() {
  const admin = await makeAccount(db, `wtadmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const ann = await makeAccount(db, `wtann${++n}`);
  const bob = await makeAccount(db, `wtbob${++n}`);
  await joinServer(db, server.id, ann.accountId);
  await joinServer(db, server.id, bob.accountId);
  const outsider = await makeAccount(db, `wtout${++n}`);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "Film" });
  return { server, ann, bob, outsider, film };
}

describe("watching together", () => {
  it("lets a member start a room, another join, and follow what each last did", async () => {
    const w = await world();
    await as(w.ann);
    const made = await start(post({ ownerKind: "title", ownerId: w.film.id }));
    expect(made.status).toBe(201);
    const { id } = await made.json();
    await as(w.bob);
    const joined = await (await look(post({}), ctx(id))).json();
    expect(joined.state).toMatchObject({ playing: false, position: 0, seq: 0 });
    expect(joined.watching.sort()).toHaveLength(2);
    // Bob presses play at 12 s; Ann then looks and sees it.
    const played = await (await look(post({ set: { playing: true, position: 12 } }), ctx(id))).json();
    expect(played.state).toMatchObject({ playing: true, position: 12, seq: 1 });
    await as(w.ann);
    const seen = await (await look(post({}), ctx(id))).json();
    expect(seen.state).toMatchObject({ playing: true, position: 12, seq: 1 });
    // Last change wins.
    await look(post({ set: { playing: false, position: 30, rate: 1.5 } }), ctx(id));
    const after = await (await look(post({}), ctx(id))).json();
    expect(after.state).toMatchObject({ playing: false, position: 30, rate: 1.5, seq: 2 });
  });

  it("is closed to someone who isn't on the server and to anything that can't be played", async () => {
    const w = await world();
    await as(w.outsider);
    expect((await start(post({ ownerKind: "title", ownerId: w.film.id }))).status).toBe(404);
    await as(w.ann);
    const { id } = await (await start(post({ ownerKind: "title", ownerId: w.film.id }))).json();
    await as(w.outsider);
    expect((await look(post({}), ctx(id))).status).toBe(404);
    expect((await look(post({}), ctx("not-a-uuid"))).status).toBe(404);
    await as(w.ann);
    expect((await look(post({ set: { playing: "yes" } }), ctx(id))).status).toBe(400);
  });

  it("turns away a ninth member and says when a room has ended", async () => {
    const w = await world();
    await as(w.ann);
    const { id } = await (await start(post({ ownerKind: "title", ownerId: w.film.id }))).json();
    const extras: Record<string, { name: string; seenAt: string }> = {};
    for (let i = 0; i < MAX_MEMBERS - 1; i++) extras[`00000000-0000-4000-8000-00000000000${i}`] = { name: `P${i}`, seenAt: new Date().toISOString() };
    await db.update(watchRooms).set({ members: extras }).where(eq(watchRooms.id, id));
    // Ann was not among them and there are already 7: she is the 8th, Bob the 9th.
    expect((await look(post({}), ctx(id))).status).toBe(200);
    await as(w.bob);
    const full = await look(post({}), ctx(id));
    expect(full.status).toBe(409);
    expect((await full.json()).code).toBe("full");
    await db.update(watchRooms).set({ members: {}, stateAt: new Date(Date.now() - ROOM_IDLE_MS - 1000) }).where(eq(watchRooms.id, id));
    const gone = await look(post({}), ctx(id));
    expect(gone.status).toBe(410);
  });
});
