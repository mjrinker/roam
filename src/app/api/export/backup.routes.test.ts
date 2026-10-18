/** The export and import routes: a profile's own data on a server it belongs to, and nothing for anyone else. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, headers: {} as Record<string, string> }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers(h.headers), cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));

import { ratings, watchState } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { GET as exportData } from "./route";
import { POST as importData } from "../import/route";

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

let n = 0;
async function world() {
  const admin = await makeAccount(db, `bkadmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, `bkme${++n}`);
  await joinServer(db, server.id, me.accountId);
  const outsider = await makeAccount(db, `bkout${++n}`);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "Heat", year: 1995, tmdbId: 949 });
  return { server, me, outsider, film };
}

describe("export and import", () => {
  it("exports the profile's data as a download, and imports a Letterboxd file back", async () => {
    const w = await world();
    await as(w.me);
    await db.insert(ratings).values({ viewerId: w.me.viewer.id, ownerKind: "title", ownerId: w.film.id, halfStars: 8 });
    const out = await exportData(new Request(`https://roam.example/api/export?serverId=${w.server.id}`));
    expect(out.status).toBe(200);
    expect(out.headers.get("content-disposition")).toMatch(/^attachment; filename="roam-.*\.json"$/);
    const file = await out.json();
    expect(file.format).toBe("roam-profile");
    expect(file.ratings).toHaveLength(1);

    const res = await importData(new Request(`https://roam.example/api/import?serverId=${w.server.id}`, { method: "POST", body: "Date,Name,Year,Letterboxd URI\n2024-01-01,Heat,1995,u\n2024-01-02,Nowhere,2000,u\n" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: "Letterboxd", watched: 1, notFound: { total: 1, sample: ["Nowhere (2000)"] } });
    expect((await db.select().from(watchState).where(and(eq(watchState.viewerId, w.me.viewer.id), eq(watchState.ownerId, w.film.id))))[0].finished).toBe(true);
  });

  it("answers someone who isn't on the server with not found, and bad files with a reason", async () => {
    const w = await world();
    await as(w.outsider);
    expect((await exportData(new Request(`https://roam.example/api/export?serverId=${w.server.id}`))).status).toBe(404);
    expect((await importData(new Request(`https://roam.example/api/import?serverId=${w.server.id}`, { method: "POST", body: "Name\nHeat\n" }))).status).toBe(404);
    await as(w.me);
    expect((await exportData(new Request("https://roam.example/api/export?serverId=nope"))).status).toBe(404);
    const bad = await importData(new Request(`https://roam.example/api/import?serverId=${w.server.id}`, { method: "POST", body: "foo,bar\n1,2\n" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/recognise/);
  });
});
