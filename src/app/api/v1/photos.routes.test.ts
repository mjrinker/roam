/** The photo API through a device token: a picture with its neighbours in the order of where it was opened from. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  headers: {} as Record<string, string>,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.headers),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));

import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { GET as photo } from "./servers/[serverId]/photos/[id]/route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
});

const req = (path = "/x") => new Request(`https://roam.example${path}`);
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};

let n = 0;
async function world() {
  const admin = await makeAccount(db, `phadmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, `phmember${++n}`);
  await joinServer(db, server.id, member.accountId);
  const lib = await makeLibrary(db, server.id, "photos", "everyone");
  const at = (day: number) => new Date(Date.UTC(2026, 0, day));
  const old = await makeTitle(db, lib.id, { kind: "photo", name: "Old", takenAt: at(1), folderPath: "Trip" });
  const mid = await makeTitle(db, lib.id, { kind: "photo", name: "Mid", takenAt: at(2), folderPath: "Trip" });
  const clip = await makeTitle(db, lib.id, { kind: "movie", name: "Clip", takenAt: at(3) });
  await as(member);
  return { server, lib, old, mid, clip, sid: { serverId: server.id } };
}

describe("a photo", () => {
  it("has its picture, and the picture before and after it, newest first", async () => {
    const w = await world();
    const body = await json(await photo(req(), ctx({ ...w.sid, id: w.mid.id })));
    expect(body).toMatchObject({ id: w.mid.id, type: "photo", name: "Mid", favorite: false, imagePath: `/api/photos/${w.mid.id}/preview`, folderPath: "Trip" });
    expect(body.prev).toEqual({ type: "clip", id: w.clip.id }); // newer
    expect(body.next).toEqual({ type: "photo", id: w.old.id }); // older
  });
  it("is a clip with no picture to fetch", async () => {
    const w = await world();
    const body = await json(await photo(req(), ctx({ ...w.sid, id: w.clip.id })));
    expect(body).toMatchObject({ type: "clip", imagePath: null });
  });
  it("stays within the album when asked", async () => {
    const w = await world();
    const body = await json(await photo(req("/x?from=album"), ctx({ ...w.sid, id: w.mid.id })));
    expect(body.prev).toBeNull();
    expect(body.next?.id).toBe(w.old.id);
  });
  it("is not found for a bad id or another server's photo, and needs a token", async () => {
    const other = await world();
    const w = await world(); // signs in as this world's member
    expect((await photo(req(), ctx({ ...w.sid, id: "nope" }))).status).toBe(404);
    expect((await photo(req(), ctx({ ...w.sid, id: other.mid.id }))).status).toBe(404);
    h.headers = {};
    expect((await photo(req(), ctx({ ...w.sid, id: w.mid.id }))).status).toBe(401);
  });
});
