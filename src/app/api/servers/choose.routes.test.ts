/** POST /api/servers/[serverId]/choose: random things to choose between, behind the usual access rules. */
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
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { POST } from "./[serverId]/choose/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}
const ask = (serverId: string, body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ serverId }) } as never);

async function world() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  await signInAs(me.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const titles = [];
  for (let i = 0; i < 3; i++) {
    const t = await makeTitle(db, lib.id, { kind: "movie", name: `Film ${i}`, ratingAges: { ANY: 0 } });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, partIndex: 0, boxFileId: `b${i}${Math.random()}`, filename: "f.mp4", container: "mp4", probeStatus: "ok", durationSeconds: 100 });
    titles.push(t);
  }
  return { server, lib, titles, me };
}

describe("the choose route", () => {
  it("gives two different movies, honours what was excluded, and says how many libraries it used", async () => {
    const w = await world();
    const res = await ask(w.server.id, { libraryIds: [w.lib.id] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.libraries).toBe(1);
    expect(new Set(body.items.map((i: { id: string }) => i.id)).size).toBe(2);
    const rest = await (await ask(w.server.id, { libraryIds: [w.lib.id], exclude: [w.titles[0].id, w.titles[1].id], count: 2 })).json();
    expect(rest.items.map((i: { id: string }) => i.id)).toEqual([w.titles[2].id]);
  });
  it("uses only libraries this profile can see: another server's or a restricted one is ignored, not an error", async () => {
    const w = await world();
    const hidden = await makeLibrary(db, w.server.id, "movies", "restricted");
    const secret = await makeTitle(db, hidden.id, { kind: "movie", name: "Secret", ratingAges: { ANY: 0 } });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: secret.id, partIndex: 0, boxFileId: `s${Math.random()}`, filename: "f.mp4", container: "mp4", probeStatus: "ok", durationSeconds: 100 });
    const body = await (await ask(w.server.id, { libraryIds: [hidden.id] })).json();
    expect(body).toMatchObject({ items: [], libraries: 0 });
    const mixed = await (await ask(w.server.id, { libraryIds: [hidden.id, w.lib.id], count: 2 })).json();
    expect(mixed.libraries).toBe(1);
    expect(mixed.items.every((i: { id: string }) => i.id !== secret.id)).toBe(true);
  });
  it("is a 404 for someone who isn't in the server, and a 400 for a bad request", async () => {
    const w = await world();
    const stranger = await makeAccount(db, "stranger");
    await signInAs(stranger.accountId);
    expect((await ask(w.server.id, { libraryIds: [w.lib.id] })).status).toBe(404);
    await signInAs(w.me.accountId);
    for (const bad of [{}, { libraryIds: [] }, { libraryIds: ["nope"] }, { libraryIds: [w.lib.id], count: 3 }, { libraryIds: [w.lib.id], exclude: ["x"] }, { libraryIds: Array.from({ length: 31 }, () => w.lib.id) }]) {
      expect((await ask(w.server.id, bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
  });
});
