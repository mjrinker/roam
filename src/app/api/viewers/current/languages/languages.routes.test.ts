/** A profile's remembered audio and subtitle languages: set from the player, private to the profile, and sent back with the play manifest. */
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
import { viewers } from "@/lib/db/schema";
import { makeAccount, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { PUT } from "./route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
});
const put = (body: unknown) => PUT(new Request("https://roam.example/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};
const prefs = async (id: string) => (await db.select({ a: viewers.audioLanguage, s: viewers.subtitleLanguage }).from(viewers).where(eq(viewers.id, id)))[0];

describe("PUT /api/viewers/current/languages", () => {
  it("remembers the audio and subtitle language for the signed-in profile only, and null forgets one", async () => {
    const me = await makeAccount(db, "lme");
    const other = await makeAccount(db, "lother");
    await as(me);
    expect((await put({ audio: "SPA", subtitles: "eng" })).status).toBe(200);
    expect(await prefs(me.viewer.id)).toEqual({ a: "spa", s: "eng" });
    expect(await prefs(other.viewer.id)).toEqual({ a: null, s: null });
    await put({ subtitles: null });
    expect(await prefs(me.viewer.id)).toEqual({ a: "spa", s: null });
  });
  it("refuses nonsense and a request that changes nothing, and needs a sign-in", async () => {
    const me = await makeAccount(db, "lbad");
    expect((await put({ audio: "spa" })).status).toBe(401);
    await as(me);
    expect((await put({ audio: "Spanish" })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await put({ audio: "spa", extra: 1 })).status).toBe(400);
  });
});
