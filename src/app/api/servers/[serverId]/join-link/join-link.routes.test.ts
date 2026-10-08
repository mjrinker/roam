/** The admin's controls for a server's open join link: admin only, uniform 404s, JSON only, strict body. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));

import { profiles, servers, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { PUT as putJoinLink } from "./route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
const uuid = () => crypto.randomUUID();

describe("PUT /api/servers/[serverId]/join-link", () => {
  const put = (serverId: string, body: unknown, type = "application/json") =>
    putJoinLink(new Request("http://x", { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": type } }), { params: Promise.resolve({ serverId }) } as never);
  async function signInAs(accountId: string) {
    const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
    const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
    h.resolution = { account, viewer: all[0], viewers: all };
  }

  it("lets the server's admin switch the link on, replace it and mark the demo, and returns the token", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    await signInAs(owner.accountId);
    const on = await (await put(server.id, { enabled: true, demo: true })).json();
    expect(on).toMatchObject({ isDemo: true });
    expect(on.joinToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const replaced = await (await put(server.id, { rotate: true })).json();
    expect(replaced.joinToken).not.toBe(on.joinToken);
    expect(await (await put(server.id, { enabled: false })).json()).toEqual({ joinToken: null, isDemo: true });
  });

  it("is the same 404 for a viewer, a stranger, a signed-out visitor, a bad id and a missing server, and changes nothing", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    const viewer = await makeAccount(db, "v");
    await joinServer(db, server.id, viewer.accountId, "viewer");
    const stranger = await makeAccount(db, "s");
    const seen = new Set<string>();
    for (const who of [viewer.accountId, stranger.accountId]) {
      await signInAs(who);
      const r = await put(server.id, { enabled: true, demo: true });
      seen.add(`${r.status} ${JSON.stringify(await r.json())}`);
    }
    h.resolution = null;
    const r1 = await put(server.id, { enabled: true });
    seen.add(`${r1.status} ${JSON.stringify(await r1.json())}`);
    await signInAs(owner.accountId);
    for (const id of ["nope", uuid()]) {
      const r = await put(id, { enabled: true });
      seen.add(`${r.status} ${JSON.stringify(await r.json())}`);
    }
    expect([...seen]).toEqual([`404 ${JSON.stringify({ error: "Not found" })}`]);
    expect((await db.select().from(servers).where(eq(servers.id, server.id)))[0]).toMatchObject({ joinToken: null, isDemo: false });
  });

  it("requires a JSON body, rejects unknown fields and wrong types, so a form posted from another site changes nothing", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    await signInAs(owner.accountId);
    expect((await put(server.id, "enabled=true", "application/x-www-form-urlencoded")).status).toBe(415);
    expect((await put(server.id, "enabled=true", "text/plain")).status).toBe(415);
    for (const bad of [{ enabled: "yes" }, { admin: true }, { enabled: true, role: "admin" }, "not json", null]) expect((await put(server.id, bad as never)).status, JSON.stringify(bad)).toBe(400);
    expect((await db.select().from(servers).where(eq(servers.id, server.id)))[0].joinToken).toBeNull();
  });
});
