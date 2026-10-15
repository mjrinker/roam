/** The lyrics route: only for songs the profile may play, nothing leaks across servers. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  headers: {} as Record<string, string>,
  lyricsFor: new Map<string, unknown>(),
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

vi.mock("@/lib/lyrics/service", () => ({
  lyricsFor: async (_db: unknown, id: string) => (h.lyricsFor.has(id) ? h.lyricsFor.get(id) : null),
}));
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { mediaFiles } from "@/lib/db/schema";
import { GET } from "./[id]/route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
  h.lyricsFor.clear();
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const call = (id: string) => GET(new Request("https://roam.example/x"), ctx(id));
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};

let n = 0;
async function world() {
  const admin = await makeAccount(db, `ladmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, `lmember${++n}`);
  await joinServer(db, server.id, member.accountId);
  const lib = await makeLibrary(db, server.id, "music", "everyone");
  const song = await makeTitle(db, lib.id, { kind: "audiobook", name: "Song" });
  await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: song.id, partIndex: 0, boxFileId: `ly${n}`, filename: "s.mp3", sizeBytes: 1, container: "mp3", probeStatus: "ok", durationSeconds: 200 });
  return { member, song };
}

describe("GET /api/lyrics/[id]", () => {
  it("gives a member the lyrics of a song, kept private to them", async () => {
    const w = await world();
    h.lyricsFor.set(w.song.id, { synced: [{ t: 1, text: "Hi" }], plain: "Hi", instrumental: false });
    await as(w.member);
    const res = await call(w.song.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ synced: [{ t: 1, text: "Hi" }], plain: "Hi", instrumental: false });
    expect(res.headers.get("cache-control")).toContain("private");
  });
  it("is not found when there are none, is refused for a song on a server the profile isn't in, and refused when signed out", async () => {
    const w = await world();
    const other = await world();
    await as(w.member);
    expect((await call(w.song.id)).status).toBe(404); // nothing found
    h.lyricsFor.set(other.song.id, { synced: null, plain: "Secret", instrumental: false });
    expect((await call(other.song.id)).status).toBe(403); // not a member there, as for playing it
    expect((await call("nope")).status).toBe(404);
    h.headers = {};
    expect((await call(w.song.id)).status).toBe(403); // not signed in: refused like the play routes
  });
});
