/** Only the platform admin decides how much of Does the Dog Die a server may use. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, admin: false }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/platform/guard", () => ({ getPlatformAdmin: async () => (h.admin ? { id: "a" } : null) }));

import { servers } from "@/lib/db/schema";
import { makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { PUT } from "./[id]/ddd/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
const put = (id: string, body: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) } as never);
const access = async (id: string) => (await db.select().from(servers).where(eq(servers.id, id)))[0].dddAccess;

describe("PUT /api/platform/servers/[id]/ddd", () => {
  it("looks like nothing is there for anyone but the platform admin, and changes nothing", async () => {
    const s = await makeServer(db, (await makeAccount(db, "o")).accountId);
    h.admin = false;
    expect((await put(s.id, { access: "full" })).status).toBe(404);
    expect(await access(s.id)).toBe("disabled");
  });
  it("sets a server's level for the platform admin, and refuses anything else", async () => {
    const s = await makeServer(db, (await makeAccount(db, "o2")).accountId);
    h.admin = true;
    expect((await put(s.id, { access: "limited" })).status).toBe(200);
    expect(await access(s.id)).toBe("limited");
    expect((await put(s.id, { access: "everything" })).status).toBe(400);
    expect((await put(s.id, { access: "full", extra: 1 })).status).toBe(400);
    expect((await put("00000000-0000-4000-8000-00000000ffff", { access: "full" })).status).toBe(404);
    expect(await access(s.id)).toBe("limited");
  });
});
