/** Where opening the app goes: the one server, else the server last used in this browser, else the servers page. */
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { joinServer, makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { resolveLandingPath } from "./servers";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

describe("resolveLandingPath", () => {
  it("goes to the servers page with none, and straight in with exactly one", async () => {
    const lonely = await makeAccount(db, "l");
    expect(await resolveLandingPath(lonely.accountId, null)).toBe("/servers");
    const owner = await makeAccount(db, "o");
    const only = await makeServer(db, owner.accountId);
    expect(await resolveLandingPath(owner.accountId, null)).toBe(`/s/${only.id}/library`);
  });

  it("with several goes back to the server last used if the account is still in it, else to the servers page", async () => {
    const me = await makeAccount(db, "me");
    const a = await makeServer(db, me.accountId);
    const b = await makeServer(db, me.accountId);
    const stranger = await makeAccount(db, "s");
    const theirs = await makeServer(db, stranger.accountId);
    expect(await resolveLandingPath(me.accountId, null)).toBe("/servers");
    expect(await resolveLandingPath(me.accountId, b.id)).toBe(`/s/${b.id}/library`);
    expect(await resolveLandingPath(me.accountId, a.id)).toBe(`/s/${a.id}/library`);
    // A server this account isn't in (left, removed, or someone else's cookie) is ignored.
    expect(await resolveLandingPath(me.accountId, theirs.id)).toBe("/servers");
    await joinServer(db, theirs.id, me.accountId);
    expect(await resolveLandingPath(me.accountId, theirs.id)).toBe(`/s/${theirs.id}/library`);
  });

  it("outside a request there is no cookie, so with several it is the servers page", async () => {
    const me = await makeAccount(db, "nocookie");
    await makeServer(db, me.accountId);
    await makeServer(db, me.accountId);
    expect(await resolveLandingPath(me.accountId)).toBe("/servers");
  });
});
