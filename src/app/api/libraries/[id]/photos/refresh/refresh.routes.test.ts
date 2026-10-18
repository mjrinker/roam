/** Looking for new photos when a photo library is opened: who may ask, and that simultaneous asks share one look. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  headers: {} as Record<string, string>,
  calls: 0,
  release: null as null | (() => void),
  gate: null as null | Promise<void>,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers(h.headers), cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
vi.mock("@/lib/scan/photos-recent", () => ({
  scanRecentPhotos: async () => {
    h.calls++;
    if (h.gate) await h.gate;
    return { added: 3, incomplete: false, errors: ["x"] };
  },
}));

import { joinServer, makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { POST } from "./route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
  h.calls = 0;
  h.gate = null;
});
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};
const ask = (id: string) => POST(new Request("https://roam.example/x", { method: "POST" }), { params: Promise.resolve({ id }) } as never);

let n = 0;
async function world() {
  const admin = await makeAccount(db, `prad${++n}`);
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, `prme${++n}`);
  await joinServer(db, server.id, me.accountId);
  const outsider = await makeAccount(db, `prout${++n}`);
  const photos = await makeLibrary(db, server.id, "photos", "everyone");
  const restricted = await makeLibrary(db, server.id, "photos", "restricted");
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  return { me, outsider, photos, restricted, movies };
}

describe("POST /api/libraries/{id}/photos/refresh", () => {
  it("looks for new photos for a member and says how many it found, without giving away problem details", async () => {
    const w = await world();
    await as(w.me);
    const res = await ask(w.photos.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 3, incomplete: false, problems: 1 });
  });

  it("is not found for a stranger, a library the profile can't see, a library that isn't photos, or a bad id", async () => {
    const w = await world();
    await as(w.outsider);
    expect((await ask(w.photos.id)).status).toBe(404);
    await as(w.me);
    expect((await ask(w.restricted.id)).status).toBe(404);
    expect((await ask(w.movies.id)).status).toBe(404);
    expect((await ask("nope")).status).toBe(404);
    expect(h.calls).toBe(0);
  });

  it("shares one look between asks that arrive together", async () => {
    const w = await world();
    await as(w.me);
    h.gate = new Promise<void>((resolve) => (h.release = resolve));
    const first = ask(w.photos.id);
    const second = ask(w.photos.id);
    await new Promise((r) => setTimeout(r, 50));
    h.release?.();
    expect([(await first).status, (await second).status]).toEqual([200, 200]);
    expect(h.calls).toBe(1);
  });
});
