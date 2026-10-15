/** An app registering (and dropping) where its notifications go. */
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

import { eq } from "drizzle-orm";
import { deviceTokens } from "@/lib/db/schema";
import { makeAccount, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken } from "@/lib/auth/device-token";
import { PUT, DELETE } from "./device/push/route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
});

const put = (body: unknown) => PUT(new Request("https://roam.example/x", { method: "PUT", body: JSON.stringify(body) }));
const stored = async (id: string) => (await db.select().from(deviceTokens).where(eq(deviceTokens.id, id)))[0].pushToken;
const TOKEN = "fcm-registration-token-1234567890";

describe("registering for push", () => {
  it("saves the app's token against this device only, replaces it, and drops it", async () => {
    const who = await makeAccount(db, "pushreg");
    const a = await createDeviceToken(db, { accountId: who.accountId, label: "Phone" });
    const b = await createDeviceToken(db, { accountId: who.accountId, label: "Tablet" });
    h.headers = { authorization: `Bearer ${a.token}` };
    expect((await put({ token: ` ${TOKEN} ` })).status).toBe(200);
    expect(await stored(a.row.id)).toBe(TOKEN);
    expect(await stored(b.row.id)).toBeNull();
    await put({ token: TOKEN + "-new" });
    expect(await stored(a.row.id)).toBe(TOKEN + "-new");
    expect((await DELETE()).status).toBe(200);
    expect(await stored(a.row.id)).toBeNull();
  });
  it("refuses what isn't a token, and anyone who isn't a signed-in app", async () => {
    const who = await makeAccount(db, "pushbad");
    const a = await createDeviceToken(db, { accountId: who.accountId, label: "Phone" });
    h.headers = { authorization: `Bearer ${a.token}` };
    for (const body of [{}, { token: 5 }, { token: "short" }, { token: "has spaces in it, long enough to pass" }, { token: "x".repeat(5000) }, null]) expect((await put(body)).status).toBe(400);
    expect(await stored(a.row.id)).toBeNull();
    h.headers = {};
    expect((await put({ token: TOKEN })).status).toBe(401);
    expect((await DELETE()).status).toBe(401);
    h.headers = { authorization: "Bearer rdt_not-a-real-token" };
    expect((await put({ token: TOKEN })).status).toBe(401);
  });
});
