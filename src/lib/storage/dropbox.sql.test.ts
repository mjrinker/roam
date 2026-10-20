/** The Dropbox provider and the OAuth token manager, against a pretend Dropbox. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

process.env.TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.DROPBOX_APP_KEY = "test-key";
process.env.DROPBOX_APP_SECRET = "test-secret";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { storageConnections } from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";
import { makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { ListingTruncatedError } from "./provider";
import { createDropboxProvider, dropboxAuthorizeUrl, dropboxExchangeCode } from "./dropbox";
import { accessTokenFor, OAuthInvalidGrantError, saveTokens } from "./oauth-tokens";
import { StorageReauthRequiredError } from "./reauth";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
afterEach(() => vi.unstubAllGlobals());

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
const stub = (routes: Record<string, Handler>) => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: String(input), init });
    const handler = routes[url.host + url.pathname];
    if (!handler) return new Response(`no route ${url.host}${url.pathname}`, { status: 599 });
    return handler(url, init);
  });
  return calls;
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body));

async function connection(over: { expiresInSeconds?: number } = {}) {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const [conn] = await db.insert(storageConnections).values({ serverId: server.id, provider: "dropbox", label: "Dropbox" }).returning();
  await saveTokens(conn.id, { accessToken: "access-1", refreshToken: "refresh-1", expiresInSeconds: over.expiresInSeconds ?? 3600 });
  return conn;
}

describe("signing in to Dropbox", () => {
  it("asks for offline access with the app's key and the redirect it was given, and to be asked who is signing in", () => {
    const u = new URL(dropboxAuthorizeUrl("https://roam.example/api/dropbox/callback", "STATE"));
    expect(u.origin + u.pathname).toBe("https://www.dropbox.com/oauth2/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: "test-key", response_type: "code", token_access_type: "offline", scope: "files.metadata.read files.content.read", redirect_uri: "https://roam.example/api/dropbox/callback", state: "STATE", force_reauthentication: "true", force_reapprove: "true" });
  });
  it("trades the code for tokens using the app's key and secret", async () => {
    const calls = stub({ "api.dropboxapi.com/oauth2/token": () => json({ access_token: "A", refresh_token: "R", expires_in: 14400, account_id: "dbid:1" }) });
    expect(await dropboxExchangeCode("the-code", "https://roam.example/cb")).toEqual({ accessToken: "A", refreshToken: "R", expiresInSeconds: 14400, scope: null });
    const body = String(calls[0].init.body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=the-code");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("test-key:test-secret").toString("base64")}`);
  });
});

describe("keeping a connection signed in", () => {
  it("uses the stored token while it has time left, and refreshes (keeping the refresh token) when it doesn't", async () => {
    const conn = await connection({ expiresInSeconds: 3600 });
    const refresher = vi.fn(async () => ({ accessToken: "access-2", refreshToken: null, expiresInSeconds: 14400 }));
    expect(await accessTokenFor(conn.id, refresher)).toBe("access-1");
    expect(refresher).not.toHaveBeenCalled();
    await db.update(storageConnections).set({ tokenExpiresAt: new Date(Date.now() + 30_000) }).where(eq(storageConnections.id, conn.id));
    expect(await accessTokenFor(conn.id, refresher)).toBe("access-2");
    expect(refresher).toHaveBeenCalledWith("refresh-1");
    const [row] = await db.select().from(storageConnections).where(eq(storageConnections.id, conn.id));
    expect([decrypt(row.accessTokenEncrypted!), decrypt(row.refreshTokenEncrypted!), row.authStatus]).toEqual(["access-2", "refresh-1", "connected"]);
  });
  it("shares one refresh between simultaneous callers", async () => {
    const conn = await connection({ expiresInSeconds: 5 });
    const refresher = vi.fn(async () => (await new Promise((r) => setTimeout(r, 20)), { accessToken: "fresh", expiresInSeconds: 3600 }));
    const tokens = await Promise.all([accessTokenFor(conn.id, refresher), accessTokenFor(conn.id, refresher), accessTokenFor(conn.id, refresher)]);
    expect(tokens).toEqual(["fresh", "fresh", "fresh"]);
    expect(refresher).toHaveBeenCalledTimes(1);
  });
  it("marks the connection as needing sign-in when the refresh token is refused, and says so", async () => {
    const conn = await connection({ expiresInSeconds: 5 });
    const refresher = async () => {
      throw new OAuthInvalidGrantError();
    };
    await expect(accessTokenFor(conn.id, refresher)).rejects.toBeInstanceOf(StorageReauthRequiredError);
    expect((await db.select().from(storageConnections).where(eq(storageConnections.id, conn.id)))[0].authStatus).toBe("needs_reauth");
  });
  it("needs sign-in for a connection that was never signed in", async () => {
    const owner = await makeAccount(db, "o");
    const server = await makeServer(db, owner.accountId);
    const [conn] = await db.insert(storageConnections).values({ serverId: server.id, provider: "dropbox", label: "Empty" }).returning();
    await expect(accessTokenFor(conn.id, async () => ({ accessToken: "x" }))).rejects.toBeInstanceOf(StorageReauthRequiredError);
  });
});

describe("the Dropbox provider", () => {
  it("lists a folder by id with files and folders told apart, following pages", async () => {
    const conn = await connection();
    const calls = stub({
      "api.dropboxapi.com/2/files/list_folder": (_u, init) => {
        expect(bodyOf(init)).toMatchObject({ path: "id:movies", recursive: false });
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-1");
        return json({ entries: [{ ".tag": "folder", id: "id:f1", name: "Film (2001)" }, { ".tag": "file", id: "id:a", name: "a.mp4", size: 100, client_modified: "2020-01-02T03:04:05Z", server_modified: "2020-02-02T03:04:05Z" }], cursor: "c1", has_more: true });
      },
      "api.dropboxapi.com/2/files/list_folder/continue": (_u, init) => {
        expect(bodyOf(init)).toEqual({ cursor: "c1" });
        return json({ entries: [{ ".tag": "file", id: "id:b", name: "b.mp4", size: 5 }, { ".tag": "deleted", name: "gone.mp4" }], cursor: "c2", has_more: false });
      },
    });
    const entries = await createDropboxProvider(conn.id).listFolder("id:movies");
    expect(entries.map((e) => [e.id, e.name, e.kind, e.sizeBytes])).toEqual([["id:f1", "Film (2001)", "folder", undefined], ["id:a", "a.mp4", "file", 100], ["id:b", "b.mp4", "file", 5]]);
    expect(entries[1].createdAt?.toISOString()).toBe("2020-01-02T03:04:05.000Z");
    expect(calls).toHaveLength(2);
  });
  it("lists the top of the account for the empty id, and refuses a listing that is cut short when asked to be strict", async () => {
    const conn = await connection();
    stub({
      "api.dropboxapi.com/2/files/list_folder": (_u, init) => {
        expect(bodyOf(init).path).toBe("");
        return json({ entries: Array.from({ length: 2000 }, (_, i) => ({ ".tag": "file", id: `id:${i}`, name: `f${i}.mp4`, size: 1 })), cursor: "c", has_more: true });
      },
      "api.dropboxapi.com/2/files/list_folder/continue": () => json({ entries: Array.from({ length: 2000 }, (_, i) => ({ ".tag": "file", id: `id:x${i}`, name: `x${i}.mp4`, size: 1 })), cursor: "c", has_more: true }),
    });
    const provider = createDropboxProvider(conn.id);
    expect(provider.rootFolderId?.()).toBe("");
    await expect(provider.listFolder("", { strict: true })).rejects.toBeInstanceOf(ListingTruncatedError);
    expect((await provider.listFolder("")).length).toBeGreaterThanOrEqual(50_000);
  });
  it("mints a temporary link (cached, but fresh on request) and reads a range through it", async () => {
    const conn = await connection();
    let links = 0;
    const calls = stub({
      "api.dropboxapi.com/2/files/get_temporary_link": () => json({ link: `https://dl.dropboxusercontent.com/t/${++links}` }),
      "dl.dropboxusercontent.com/t/1": (_u, init) => {
        expect((init.headers as Record<string, string>).Range).toBe("bytes=2-5");
        return new Response(new Uint8Array([2, 3, 4, 5]), { status: 206 });
      },
    });
    const p = createDropboxProvider(conn.id);
    const a = await p.getStreamingUrl("id:a");
    expect(a.url).toBe("https://dl.dropboxusercontent.com/t/1");
    expect(a.expiresAt.getTime() - Date.now()).toBeGreaterThan(3 * 3600_000);
    expect(a.expiresAt.getTime() - Date.now()).toBeLessThan(4 * 3600_000);
    expect(Array.from(new Uint8Array(await p.fetchByteRange("id:a", 2, 5)))).toEqual([2, 3, 4, 5]);
    expect(links).toBe(1); // the link was reused for the range read
    expect((await p.getFreshDownloadUrl!("id:a")).url).toBe("https://dl.dropboxusercontent.com/t/2");
    expect(calls.filter((c) => c.url.includes("get_temporary_link"))).toHaveLength(2);
  });
  it("trims a range out of a whole-file answer from a server that ignored Range", async () => {
    const conn = await connection();
    stub({
      "api.dropboxapi.com/2/files/get_temporary_link": () => json({ link: "https://dl.dropboxusercontent.com/t/x" }),
      "dl.dropboxusercontent.com/t/x": () => new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6]), { status: 200 }),
    });
    expect(Array.from(new Uint8Array(await createDropboxProvider(conn.id).fetchByteRange("id:a", 1, 3)))).toEqual([1, 2, 3]);
  });
  it("says whether a file or folder still exists, and returns null for a folder that is gone", async () => {
    const conn = await connection();
    stub({
      "api.dropboxapi.com/2/files/get_metadata": (_u, init) => {
        const path = bodyOf(init).path;
        if (path === "id:gone") return json({ error_summary: "path/not_found/.", error: { ".tag": "path" } }, 409);
        if (path === "id:dir") return json({ ".tag": "folder", id: "id:dir", name: "Dir" });
        return json({ ".tag": "file", id: path, name: "f.mp4", size: 1 });
      },
    });
    const p = createDropboxProvider(conn.id);
    expect(await p.fileExists!("id:there")).toBe(true);
    expect(await p.fileExists!("id:gone")).toBe(false);
    expect(await p.getFolder("id:gone")).toBeNull();
    expect(await p.getFolder("id:there")).toBeNull(); // a file isn't a folder
    expect(await p.getFolder("id:dir")).toMatchObject({ id: "id:dir", name: "Dir", kind: "folder" });
  });
  it("refreshes once on a 401 and retries, and asks for sign-in if it is still refused", async () => {
    const conn = await connection();
    let tokenCalls = 0;
    let attempts = 0;
    stub({
      "api.dropboxapi.com/oauth2/token": () => (tokenCalls++, json({ access_token: "access-2", expires_in: 14400 })),
      "api.dropboxapi.com/2/files/get_metadata": (_u, init) => {
        attempts++;
        return (init.headers as Record<string, string>).Authorization === "Bearer access-2" ? json({ ".tag": "file", id: "id:a", name: "a", size: 1 }) : json({ error_summary: "expired_access_token" }, 401);
      },
    });
    expect(await createDropboxProvider(conn.id).fileExists!("id:a")).toBe(true);
    expect([tokenCalls, attempts]).toEqual([1, 2]);

    const conn2 = await connection();
    stub({ "api.dropboxapi.com/oauth2/token": () => json({ access_token: "still-bad", expires_in: 14400 }), "api.dropboxapi.com/2/files/get_metadata": () => json({ error_summary: "invalid_access_token" }, 401) });
    await expect(createDropboxProvider(conn2.id).fileExists!("id:a")).rejects.toBeInstanceOf(StorageReauthRequiredError);
  });
  it("marks the connection dead when Dropbox says the refresh token is no good", async () => {
    const conn = await connection({ expiresInSeconds: 5 });
    stub({ "api.dropboxapi.com/oauth2/token": () => new Response('{"error":"invalid_grant"}', { status: 400 }) });
    await expect(createDropboxProvider(conn.id).listFolder("")).rejects.toBeInstanceOf(StorageReauthRequiredError);
    expect((await db.select().from(storageConnections).where(eq(storageConnections.id, conn.id)))[0].authStatus).toBe("needs_reauth");
  });
  it("returns no picture for a file Dropbox can't make one of, and the picture when it can", async () => {
    const conn = await connection();
    stub({
      "content.dropboxapi.com/2/files/get_thumbnail_v2": (_u, init) => {
        const arg = JSON.parse((init.headers as Record<string, string>)["Dropbox-API-Arg"]);
        return arg.resource.path === "id:video" ? new Response('{"error_summary":"unsupported_extension"}', { status: 409 }) : new Response(new Uint8Array([0xff, 0xd8, 1]), { status: 200 });
      },
    });
    const p = createDropboxProvider(conn.id);
    expect(await p.fetchThumbnail!("id:video")).toBeNull();
    expect(Array.from((await p.fetchThumbnail!("id:photo"))!.bytes)).toEqual([0xff, 0xd8, 1]);
    expect((await p.fetchPreview!("id:photo"))).toMatchObject({ contentType: "image/jpeg", size: 2048 });
    expect(await p.fetchPreview!("id:video")).toBeNull();
  });
  it("says which permission the Dropbox app is missing, and what to do about it", async () => {
    const conn = await connection();
    stub({ "api.dropboxapi.com/2/files/list_folder": () => new Response(`Error in call to API function "files/list_folder": Your app (ID: 1) is not permitted to access this endpoint because it does not have the required scope 'files.metadata.read'. The owner of the app can enable the scope`, { status: 400 }) });
    await expect(createDropboxProvider(conn.id).listFolder("")).rejects.toThrow(/"files.metadata.read" permission[\s\S]*Permissions tab[\s\S]*Reconnect/);
  });
  it("waits out a rate limit and tries again", async () => {
    const conn = await connection();
    let n = 0;
    stub({ "api.dropboxapi.com/2/files/get_metadata": () => (++n === 1 ? json({ error_summary: "too_many_requests" }, 429, { "retry-after": "0" }) : json({ ".tag": "file", id: "id:a", name: "a", size: 1 })) });
    expect(await createDropboxProvider(conn.id).fileExists!("id:a")).toBe(true);
    expect(n).toBe(2);
  });
});
