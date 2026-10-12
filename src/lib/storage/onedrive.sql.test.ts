/** The OneDrive provider against a pretend Microsoft Graph. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

process.env.TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.MICROSOFT_CLIENT_ID = "ms-id";
process.env.MICROSOFT_CLIENT_SECRET = "ms-secret";

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
import { createOneDriveProvider, onedriveAccountName, onedriveAuthorizeUrl, onedriveExchangeCode } from "./onedrive";
import { saveTokens } from "./oauth-tokens";
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
    const handler = routes[url.host + decodeURIComponent(url.pathname)];
    return handler ? handler(url, init) : new Response(`no route ${url.host}${url.pathname}`, { status: 599 });
  });
  return calls;
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function connection(expiresInSeconds = 3600) {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const [conn] = await db.insert(storageConnections).values({ serverId: server.id, provider: "onedrive", label: "OneDrive" }).returning();
  await saveTokens(conn.id, { accessToken: "access-1", refreshToken: "refresh-1", expiresInSeconds });
  return conn;
}

describe("signing in to Microsoft", () => {
  it("asks to read files with offline access, from personal and work accounts", () => {
    const u = new URL(onedriveAuthorizeUrl("https://roam.example/api/onedrive/callback", "STATE"));
    expect(u.origin + u.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "ms-id", response_type: "code", redirect_uri: "https://roam.example/api/onedrive/callback", state: "STATE" });
    expect(u.searchParams.get("scope")).toBe("offline_access Files.Read.All User.Read");
  });
  it("trades the code for tokens, sending the app's id and secret", async () => {
    const calls = stub({ "login.microsoftonline.com/common/oauth2/v2.0/token": () => json({ access_token: "A", refresh_token: "R", expires_in: 3599 }) });
    expect(await onedriveExchangeCode("code-1", "https://roam.example/cb")).toEqual({ accessToken: "A", refreshToken: "R", expiresInSeconds: 3599 });
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(Object.fromEntries(body)).toMatchObject({ client_id: "ms-id", client_secret: "ms-secret", grant_type: "authorization_code", code: "code-1" });
  });
  it("shows the account by email, falling back to the sign-in name", async () => {
    stub({ "graph.microsoft.com/v1.0/me": () => json({ mail: null, userPrincipalName: "matt@outlook.com", displayName: "Matt" }) });
    expect(await onedriveAccountName("tok")).toBe("matt@outlook.com");
  });
});

describe("the OneDrive provider", () => {
  it("keeps the new refresh token Microsoft hands back each time it refreshes", async () => {
    const conn = await connection(5);
    stub({
      "login.microsoftonline.com/common/oauth2/v2.0/token": (_u, init) => {
        expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe("refresh-1");
        return json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
      },
      "graph.microsoft.com/v1.0/me/drive/items/x": () => json({ id: "x", name: "x", file: {} }),
    });
    await createOneDriveProvider(conn.id).fileExists!("x");
    const [row] = await db.select().from(storageConnections).where(eq(storageConnections.id, conn.id));
    expect([decrypt(row.accessTokenEncrypted!), decrypt(row.refreshTokenEncrypted!)]).toEqual(["access-2", "refresh-2"]);
  });
  it("lists a folder by item id, telling files, folders and other things apart, following pages", async () => {
    const conn = await connection();
    const calls = stub({
      "graph.microsoft.com/v1.0/me/drive/items/ABC!123/children": () =>
        json({
          value: [
            { id: "F1", name: "Film (2001)", folder: { childCount: 2 } },
            { id: "A", name: "a.mp4", size: 100, file: { mimeType: "video/mp4" }, createdDateTime: "2020-01-02T03:04:05Z", lastModifiedDateTime: "2020-02-02T03:04:05Z" },
            { id: "N", name: "Notebook", package: { type: "oneNote" } },
            { id: "D", name: "gone.mp4", file: {}, deleted: { state: "deleted" } },
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/items/ABC!123/children?$skiptoken=2",
        }),
    });
    // The second page comes from the nextLink URL.
    const pageTwo = vi.fn(() => json({ value: [{ id: "B", name: "b.mp4", size: 5, file: {} }] }));
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => (String(input).includes("skiptoken=2") ? pageTwo() : original(input, init)));
    const entries = await createOneDriveProvider(conn.id).listFolder("ABC!123");
    expect(entries.map((e) => [e.id, e.name, e.kind, e.sizeBytes])).toEqual([["F1", "Film (2001)", "folder", undefined], ["A", "a.mp4", "file", 100], ["B", "b.mp4", "file", 5]]);
    expect(entries[1].createdAt?.toISOString()).toBe("2020-01-02T03:04:05.000Z");
    expect(calls[0].url).toContain("/items/ABC!123/children");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer access-1");
  });
  it("uses the alias 'root' for the top of the drive, and refuses a runaway listing when strict", async () => {
    const conn = await connection();
    stub({
      "graph.microsoft.com/v1.0/me/drive/items/root/children": () => json({ value: Array.from({ length: 1000 }, (_, i) => ({ id: `i${i}`, name: `f${i}.mp4`, size: 1, file: {} })), "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/items/root/children?$skiptoken=n" }),
    });
    const p = createOneDriveProvider(conn.id);
    expect(p.rootFolderId?.()).toBe("root");
    // every page is the same page here, so the listing never ends by itself
    const runaway = vi.fn(() => json({ value: Array.from({ length: 1000 }, (_, i) => ({ id: `j${i}`, name: `g${i}.mp4`, size: 1, file: {} })), "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/items/root/children?$skiptoken=n" }));
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => (String(input).includes("skiptoken=n") ? runaway() : original(input, init)));
    await expect(p.listFolder("root", { strict: true })).rejects.toBeInstanceOf(ListingTruncatedError);
    expect((await p.listFolder("root")).length).toBeGreaterThanOrEqual(50_000);
  });
  it("streams through the file's own pre-authenticated link, cached, fresh on request, and reads a range through it", async () => {
    const conn = await connection();
    let n = 0;
    stub({
      "graph.microsoft.com/v1.0/me/drive/items/A": () => json({ id: "A", "@microsoft.graph.downloadUrl": `https://dl.example/${++n}` }),
      "dl.example/1": (_u, init) => {
        expect((init.headers as Record<string, string>).Range).toBe("bytes=2-5");
        return new Response(new Uint8Array([2, 3, 4, 5]), { status: 206 });
      },
    });
    const p = createOneDriveProvider(conn.id);
    const a = await p.getStreamingUrl("A");
    expect(a.url).toBe("https://dl.example/1");
    expect(a.expiresAt.getTime() - Date.now()).toBeGreaterThan(30 * 60_000);
    expect(a.expiresAt.getTime() - Date.now()).toBeLessThan(60 * 60_000);
    expect(Array.from(new Uint8Array(await p.fetchByteRange("A", 2, 5)))).toEqual([2, 3, 4, 5]);
    expect(n).toBe(1);
    expect((await p.getFreshDownloadUrl!("A")).url).toBe("https://dl.example/2");
  });
  it("says an item has no link rather than handing back nothing", async () => {
    const conn = await connection();
    stub({ "graph.microsoft.com/v1.0/me/drive/items/F": () => json({ id: "F" }) });
    await expect(createOneDriveProvider(conn.id).getStreamingUrl("F")).rejects.toThrow(/no download link/);
  });
  it("says whether an item still exists, and gives null for a folder that is gone or is really a file", async () => {
    const conn = await connection();
    stub({
      "graph.microsoft.com/v1.0/me/drive/items/there": () => json({ id: "there", name: "f", file: {} }),
      "graph.microsoft.com/v1.0/me/drive/items/trashed": () => json({ id: "trashed", deleted: {} }),
      "graph.microsoft.com/v1.0/me/drive/items/gone": () => json({ error: { code: "itemNotFound" } }, 404),
      "graph.microsoft.com/v1.0/me/drive/items/dir": () => json({ id: "dir", name: "Dir", folder: {} }),
    });
    const p = createOneDriveProvider(conn.id);
    expect(await p.fileExists!("there")).toBe(true);
    expect(await p.fileExists!("trashed")).toBe(false);
    expect(await p.fileExists!("gone")).toBe(false);
    expect(await p.getFolder("gone")).toBeNull();
    expect(await p.getFolder("there")).toBeNull();
    expect(await p.getFolder("dir")).toMatchObject({ id: "dir", name: "Dir", kind: "folder" });
  });
  it("refreshes once on a 401, then asks for sign-in if it is still refused", async () => {
    const conn = await connection();
    let tokens = 0;
    stub({
      "login.microsoftonline.com/common/oauth2/v2.0/token": () => (tokens++, json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 })),
      "graph.microsoft.com/v1.0/me/drive/items/x": (_u, init) => ((init.headers as Record<string, string>).Authorization === "Bearer access-2" ? json({ id: "x", file: {} }) : json({ error: { code: "InvalidAuthenticationToken" } }, 401)),
    });
    expect(await createOneDriveProvider(conn.id).fileExists!("x")).toBe(true);
    expect(tokens).toBe(1);
    const conn2 = await connection();
    stub({ "login.microsoftonline.com/common/oauth2/v2.0/token": () => json({ access_token: "bad", refresh_token: "r", expires_in: 3600 }), "graph.microsoft.com/v1.0/me/drive/items/x": () => json({}, 401) });
    await expect(createOneDriveProvider(conn2.id).fileExists!("x")).rejects.toBeInstanceOf(StorageReauthRequiredError);
  });
  it("marks the connection as needing sign-in when Microsoft refuses the refresh token", async () => {
    const conn = await connection(5);
    stub({ "login.microsoftonline.com/common/oauth2/v2.0/token": () => new Response('{"error":"invalid_grant","error_description":"AADSTS70008: The provided authorization code or refresh token has expired"}', { status: 400 }) });
    await expect(createOneDriveProvider(conn.id).listFolder("root")).rejects.toBeInstanceOf(StorageReauthRequiredError);
    expect((await db.select().from(storageConnections).where(eq(storageConnections.id, conn.id)))[0].authStatus).toBe("needs_reauth");
  });
  it("fetches pictures from OneDrive's thumbnails: the larger preview when offered, else the large one, and none when there is none", async () => {
    const conn = await connection();
    stub({
      "graph.microsoft.com/v1.0/me/drive/items/photo/thumbnails": (u) => json({ value: [u.searchParams.get("$select")!.includes("2048x2048") ? { "2048x2048": { url: "https://thumb.example/big", width: 2048 }, large: { url: "https://thumb.example/large", width: 800 } } : { large: { url: "https://thumb.example/large", width: 800 } }] }),
      "graph.microsoft.com/v1.0/me/drive/items/odd/thumbnails": () => json({ value: [{ large: { url: "https://thumb.example/large", width: 800 } }] }),
      "graph.microsoft.com/v1.0/me/drive/items/none/thumbnails": () => json({ value: [] }),
      "graph.microsoft.com/v1.0/me/drive/items/missing/thumbnails": () => json({}, 404),
      "thumb.example/big": () => new Response(new Uint8Array([9, 9]), { status: 200 }),
      "thumb.example/large": () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    });
    const p = createOneDriveProvider(conn.id);
    expect(await p.fetchPreview!("photo")).toMatchObject({ size: 2048 });
    expect(Array.from((await p.fetchPreview!("photo"))!.bytes)).toEqual([9, 9]);
    expect(await p.fetchPreview!("odd")).toMatchObject({ size: 800 });
    expect(Array.from((await p.fetchThumbnail!("photo"))!.bytes)).toEqual([1, 2, 3]);
    expect(await p.fetchThumbnail!("none")).toBeNull();
    expect(await p.fetchThumbnail!("missing")).toBeNull();
  });
  it("waits out a rate limit and tries again", async () => {
    const conn = await connection();
    let n = 0;
    stub({ "graph.microsoft.com/v1.0/me/drive/items/x": () => (++n === 1 ? json({ error: { code: "activityLimitReached" } }, 429, { "retry-after": "0" }) : json({ id: "x", file: {} })) });
    expect(await createOneDriveProvider(conn.id).fileExists!("x")).toBe(true);
    expect(n).toBe(2);
  });
});
