/** Signing in to Dropbox, OneDrive and Google Drive with and without permission to edit files: what the connection ends up allowed to do. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

process.env.TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.OAUTH_STATE_SECRET ??= "state-secret-for-tests";
process.env.DROPBOX_APP_KEY = "dk";
process.env.DROPBOX_APP_SECRET = "ds";
process.env.MICROSOFT_CLIENT_ID = "mid";
process.env.MICROSOFT_CLIENT_SECRET = "ms";
process.env.GOOGLE_CLIENT_ID = "gid";
process.env.GOOGLE_CLIENT_SECRET = "gs";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown, scope: "" }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/platform/accounts", () => ({ recordProviderAccount: async () => undefined }));

import { profiles, storageConnections, viewers } from "@/lib/db/schema";
import { makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { signBoxOAuthState } from "@/lib/storage/box-oauth-state";
import { GET as dropboxConnect } from "../dropbox/connect/route";
import { GET as dropboxCallback } from "../dropbox/callback/route";
import { GET as googleCallback } from "../google/callback/route";
import { GET as onedriveCallback } from "../onedrive/callback/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
afterEach(() => vi.unstubAllGlobals());

async function admin() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const [account] = await db.select().from(profiles).where(eq(profiles.id, owner.accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, owner.accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
  return { server, owner };
}
/** The three services answer the code exchange with these permissions, and everything else with something harmless. */
function pretendServices(scope: string) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (/token/.test(url)) return new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_in: 3600, scope }), { status: 200 });
    return new Response(JSON.stringify({ email: "me@example.com", mail: "me@example.com", user: { emailAddress: "me@example.com" } }), { status: 200 });
  });
}
const callback = (route: typeof dropboxCallback, provider: string, state: string) => route(new Request(`https://roam.test/api/${provider}/callback?code=c&state=${encodeURIComponent(state)}`));
const connectionOf = async (id: string) => (await db.select().from(storageConnections).where(eq(storageConnections.id, id)))[0];

describe.each([
  ["dropbox", dropboxCallback, "dropbox", "files.metadata.read files.content.read", "files.metadata.read files.content.read files.content.write"],
  ["onedrive", onedriveCallback, "onedrive", "User.Read Files.Read.All", "User.Read Files.ReadWrite.All"],
  ["google", googleCallback, "gdrive", "https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive"],
] as const)("signing in to %s", (route, handler, kind, readScope, writeScope) => {
  it("a plain sign-in leaves it read-only", async () => {
    const { server, owner } = await admin();
    pretendServices(readScope);
    const id = crypto.randomUUID();
    const res = await callback(handler, route, signBoxOAuthState(server.id, owner.accountId, { connectionId: id, label: "X" }));
    expect(res.headers.get("location")).toBe(`https://roam.test/s/${server.id}/admin`);
    expect(await connectionOf(id)).toMatchObject({ provider: kind, authStatus: "connected", writeGranted: false, writeEnabled: false });
  });

  it("a sign-in for editing, given the permission, turns editing on; a plain one afterwards turns it off again", async () => {
    const { server, owner } = await admin();
    pretendServices(writeScope);
    const id = crypto.randomUUID();
    const res = await callback(handler, route, signBoxOAuthState(server.id, owner.accountId, { connectionId: id, label: "X", write: true }));
    expect(res.headers.get("location")).toBe(`https://roam.test/s/${server.id}/admin`);
    expect(await connectionOf(id)).toMatchObject({ writeGranted: true, writeEnabled: true });
    pretendServices(readScope);
    await callback(handler, route, signBoxOAuthState(server.id, owner.accountId, { connectionId: id, write: false }));
    expect(await connectionOf(id)).toMatchObject({ writeGranted: false, writeEnabled: false });
  });

  it("a sign-in that asked for editing but wasn't given the permission stays read-only, and the admin is told", async () => {
    const { server, owner } = await admin();
    pretendServices(readScope);
    const id = crypto.randomUUID();
    const res = await callback(handler, route, signBoxOAuthState(server.id, owner.accountId, { connectionId: id, label: "X", write: true }));
    expect(res.headers.get("location")).toBe(`https://roam.test/s/${server.id}/admin?error=storage-write-denied`);
    expect(await connectionOf(id)).toMatchObject({ authStatus: "connected", writeGranted: false, writeEnabled: false });
  });
});

describe("starting a sign-in", () => {
  it("asks for editing only when the admin said so", async () => {
    const { server } = await admin();
    const go = async (extra: string) => {
      const res = await dropboxConnect(new Request(`https://roam.test/api/dropbox/connect?serverId=${server.id}&connectionId=new&label=X${extra}`));
      return new URL(res.headers.get("location")!).searchParams.get("scope");
    };
    expect(await go("")).toBe("files.metadata.read files.content.read");
    expect(await go("&write=1")).toBe("files.metadata.read files.content.read files.content.write");
  });
});
