/** The platform admin numbers, and the ledger of outside accounts that the Dropbox 50-account limit is read from. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  dropboxRevoked: [] as string[],
  googleRevoked: [] as string[],
  revokeFails: false,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => `plain:${s}`, encrypt: (s: string) => s }));
vi.mock("@/lib/storage/oauth-tokens", () => ({ accessTokenFor: async (id: string) => `token-of-${id}`, saveTokens: async () => {} }));
vi.mock("@/lib/storage/dropbox", () => ({
  dropboxRefresher: {},
  dropboxRevoke: async (token: string) => {
    if (h.revokeFails) throw new Error("boom");
    h.dropboxRevoked.push(token);
  },
}));
vi.mock("@/lib/storage/google-drive", () => ({
  googleRevoke: async (token: string) => {
    h.googleRevoked.push(token);
  },
}));

import { providerAccounts, storageConnections } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle } from "@/lib/playlists/test-db";
import { recordProviderAccount, releaseConnections } from "./accounts";
import { loadPlatformStats, usageStatus } from "./stats";

let db: import("@/lib/playlists/test-db").TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
beforeEach(() => {
  h.dropboxRevoked.length = 0;
  h.googleRevoked.length = 0;
  h.revokeFails = false;
});

async function connect(serverId: string, provider: "dropbox" | "gdrive" | "onedrive" | "box", account: string | null) {
  const [c] = await db
    .insert(storageConnections)
    .values({ serverId, provider, label: account ?? "Box", accountName: account, refreshTokenEncrypted: "r", authStatus: "connected" })
    .returning();
  await recordProviderAccount(provider, account);
  return c;
}
const ledgerRow = async (provider: "dropbox" | "gdrive", key: string) =>
  (await db.select().from(providerAccounts).where(and(eq(providerAccounts.provider, provider), eq(providerAccounts.accountKey, key))))[0];

describe("usageStatus", () => {
  it("warns at 80% of the cap and is full at the cap; no cap means no status", () => {
    expect(usageStatus(39, 50)).toBe("ok");
    expect(usageStatus(40, 50)).toBe("warn");
    expect(usageStatus(49, 50)).toBe("warn");
    expect(usageStatus(50, 50)).toBe("full");
    expect(usageStatus(500, null)).toBe("none");
  });
});

describe("the linked-accounts ledger", () => {
  it("counts one account once however many servers use it, ignoring case", async () => {
    const a = await makeServer(db, (await makeAccount(db, "a")).accountId);
    const b = await makeServer(db, (await makeAccount(db, "b")).accountId);
    await connect(a.id, "dropbox", "Dana@Example.com");
    await connect(b.id, "dropbox", "dana@example.com");
    await connect(b.id, "box", "dana@example.com");
    const stats = await loadPlatformStats(db);
    const dropbox = stats.providers.find((p) => p.provider === "dropbox")!;
    expect(dropbox.linked).toBe(1);
    expect(dropbox.cap).toBe(50);
    expect(dropbox.accounts[0].servers.sort()).toEqual([a.name, b.name].sort());
    // Box is listed too (see below), but only the Dropbox account counts toward Dropbox.
    expect(dropbox.accounts.filter((x) => x.label.toLowerCase() === "dana@example.com")).toHaveLength(1);
  });

  it("unlinks an account at Dropbox only when its last connection goes, and stops counting it", async () => {
    const owner = await makeAccount(db, "o");
    const a = await makeServer(db, owner.accountId);
    const b = await makeServer(db, owner.accountId);
    const c1 = await connect(a.id, "dropbox", "shared@example.com");
    const c2 = await connect(b.id, "dropbox", "shared@example.com");
    expect(await releaseConnections([c1.id])).toBe(0);
    expect(h.dropboxRevoked).toEqual([]);
    expect((await ledgerRow("dropbox", "shared@example.com")).revokedAt).toBeNull();
    await db.delete(storageConnections).where(eq(storageConnections.id, c1.id));
    expect(await releaseConnections([c2.id])).toBe(1);
    expect(h.dropboxRevoked).toEqual([`token-of-${c2.id}`]);
    expect((await ledgerRow("dropbox", "shared@example.com")).revokedAt).not.toBeNull();
  });

  it("removing both of an account's connections at once (a server delete) unlinks it once", async () => {
    const s = await makeServer(db, (await makeAccount(db, "o2")).accountId);
    const c1 = await connect(s.id, "dropbox", "twice@example.com");
    const c2 = await connect(s.id, "dropbox", "twice@example.com");
    expect(await releaseConnections([c1.id, c2.id])).toBe(1);
    expect(h.dropboxRevoked).toHaveLength(1);
  });

  it("unlinks a Google account with its refresh token", async () => {
    const s = await makeServer(db, (await makeAccount(db, "o3")).accountId);
    const c = await connect(s.id, "gdrive", "g@example.com");
    await releaseConnections([c.id]);
    expect(h.googleRevoked).toEqual(["plain:r"]);
  });

  it("a failed unlink leaves the account counted (so the number never understates), and never throws", async () => {
    const s = await makeServer(db, (await makeAccount(db, "o4")).accountId);
    const c = await connect(s.id, "dropbox", "stuck@example.com");
    h.revokeFails = true;
    await expect(releaseConnections([c.id])).resolves.toBe(0);
    expect((await ledgerRow("dropbox", "stuck@example.com")).revokedAt).toBeNull();
  });

  it("connecting again after an unlink counts the account again", async () => {
    const s = await makeServer(db, (await makeAccount(db, "o5")).accountId);
    const c = await connect(s.id, "dropbox", "back@example.com");
    await releaseConnections([c.id]);
    await recordProviderAccount("dropbox", "back@example.com");
    expect((await ledgerRow("dropbox", "back@example.com")).revokedAt).toBeNull();
  });
});

describe("the platform numbers", () => {
  it("reports connections needing sign-in, never-scanned libraries and per-server totals", async () => {
    const owner = await makeAccount(db, "stats");
    const s = await makeServer(db, owner.accountId);
    await makeLibrary(db, s.id, "movies");
    const [c] = await db.insert(storageConnections).values({ serverId: s.id, provider: "dropbox", label: "Needs me", accountName: "n@example.com", authStatus: "needs_reauth" }).returning();
    const stats = await loadPlatformStats(db);
    expect(stats.health.needsReauth.some((r) => r.label === c.label && r.serverName === s.name)).toBe(true);
    expect(stats.health.neverScanned.some((l) => l.serverName === s.name)).toBe(true);
    const row = stats.servers.find((x) => x.id === s.id)!;
    expect(row).toMatchObject({ members: 1, libraries: 1, connections: 1 });
    expect(stats.totals.accounts).toBeGreaterThan(0);
  });

  it("counts Box accounts too (once each, however many servers), with no limit", async () => {
    const a = await makeServer(db, (await makeAccount(db, "bx1")).accountId);
    const b = await makeServer(db, (await makeAccount(db, "bx2")).accountId);
    await connect(a.id, "box", "Box.Person@Example.com");
    await connect(b.id, "box", "box.person@example.com");
    await connect(b.id, "box", null);
    const box = (await loadPlatformStats(db)).providers.find((p) => p.provider === ("box" as never))!;
    expect(box.cap).toBeNull();
    expect(box.status).toBe("none");
    const mine = box.accounts.filter((x) => x.label.toLowerCase().includes("box.person@example.com"));
    expect(mine).toHaveLength(1);
    expect(mine[0].servers.sort()).toEqual([a.name, b.name].sort());
    expect(box.accounts.some((x) => x.label.includes("account not known"))).toBe(true);
  });

  it("breaks items down per library type", async () => {
    const s = await makeServer(db, (await makeAccount(db, "kinds")).accountId);
    const photos = await makeLibrary(db, s.id, "photos");
    const books = await makeLibrary(db, s.id, "audiobooks");
    await makeTitle(db, photos.id);
    await makeTitle(db, photos.id);
    await makeTitle(db, books.id);
    const rows = (await loadPlatformStats(db)).itemsByKind;
    const of = (k: string) => rows.find((r) => r.kind === k)!;
    expect(of("photos").items).toBeGreaterThanOrEqual(2);
    expect(of("audiobooks").items).toBeGreaterThanOrEqual(1);
    expect(of("photos").libraries).toBeGreaterThanOrEqual(1);
    expect(rows.every((r, i) => i === 0 || rows[i - 1].items >= r.items)).toBe(true);
  });
});
