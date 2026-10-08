/** The play route on a demo server: allowed up to the daily total, then a clear 429 that is never cached; other servers unaffected. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown, built: 0 }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/player/manifest", () => ({
  buildPlayManifest: async () => (h.built++, { ok: true, manifest: { segments: [] } }),
}));
vi.mock("@/lib/auth/demo-limits", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/demo-limits")>();
  return { ...original, checkDemoPlay: (s: string, a: string) => original.checkDemoPlay(s, a, { perDay: 2, perAccountPerHour: 100 }) };
});

import { profiles, servers, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { GET } from "./[ownerKind]/[ownerId]/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const ctx = (ownerId: string) => ({ params: Promise.resolve({ ownerKind: "title", ownerId }) }) as never;
async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}

async function world(demo: boolean) {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  if (demo) await db.update(servers).set({ isDemo: true }).where(eq(servers.id, server.id));
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, lib.id, { kind: "movie" });
  const guest = await makeAccount(db, "g");
  await joinServer(db, server.id, guest.accountId);
  await signInAs(guest.accountId);
  return { film };
}

describe("GET /api/play on a demo server", () => {
  it("serves plays up to the daily total, then a 429 with the resting message that is never cached", async () => {
    const { film } = await world(true);
    h.built = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await GET(new Request("http://x"), ctx(film.id))).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
    expect(h.built).toBe(2); // no manifest (no Box calls) was built for the refused plays
    const refused = await GET(new Request("http://x"), ctx(film.id));
    expect([refused.headers.get("cache-control"), (await refused.json()).error]).toEqual(["no-store", expect.stringContaining("resting")]);
  });

  it("does not limit an ordinary server at all", async () => {
    const { film } = await world(false);
    for (let i = 0; i < 6; i++) expect((await GET(new Request("http://x"), ctx(film.id))).status).toBe(200);
  });
});
