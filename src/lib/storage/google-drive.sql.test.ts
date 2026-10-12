/** The Google Drive provider and its stream route, against a pretend Google. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

process.env.TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.GOOGLE_CLIENT_ID = "g-id";
process.env.GOOGLE_CLIENT_SECRET = "g-secret";
process.env.NEXT_PUBLIC_APP_URL = "https://roam.example.com";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { storageConnections } from "@/lib/db/schema";
import { makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { ListingTruncatedError } from "./provider";
import { createGoogleDriveProvider, googleAccountName, googleAuthorizeUrl, googleExchangeCode } from "./google-drive";
import { saveTokens } from "./oauth-tokens";
import { StorageReauthRequiredError } from "./reauth";
import { signStreamToken, verifyStreamToken } from "./stream-token";
import { GET, HEAD } from "@/app/api/storage/stream/[token]/route";

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
const hdr = (init: RequestInit) => init.headers as Record<string, string>;

async function connection(over: { provider?: "gdrive" | "box"; expiresInSeconds?: number } = {}) {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const [conn] = await db.insert(storageConnections).values({ serverId: server.id, provider: over.provider ?? "gdrive", label: "Drive" }).returning();
  await saveTokens(conn.id, { accessToken: "access-1", refreshToken: "refresh-1", expiresInSeconds: over.expiresInSeconds ?? 3600 });
  return conn;
}

describe("signing in to Google", () => {
  it("asks for read-only Drive access, offline, with a fresh consent so a refresh token is always issued", () => {
    const u = new URL(googleAuthorizeUrl("https://roam.example.com/api/google/callback", "STATE"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "g-id", response_type: "code", scope: "https://www.googleapis.com/auth/drive.readonly", access_type: "offline", prompt: "select_account consent", state: "STATE" });
  });
  it("trades the code for tokens, and names the account by email", async () => {
    const calls = stub({
      "oauth2.googleapis.com/token": () => json({ access_token: "A", refresh_token: "R", expires_in: 3599 }),
      "www.googleapis.com/drive/v3/about": (u) => (expect(u.searchParams.get("fields")).toContain("emailAddress"), json({ user: { emailAddress: "me@gmail.com", displayName: "Me" } })),
    });
    expect(await googleExchangeCode("code-1", "https://roam.example.com/cb")).toEqual({ accessToken: "A", refreshToken: "R", expiresInSeconds: 3599 });
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toMatchObject({ client_id: "g-id", client_secret: "g-secret", grant_type: "authorization_code", code: "code-1" });
    expect(await googleAccountName("tok")).toBe("me@gmail.com");
  });
});

describe("the Google Drive provider", () => {
  it("lists a folder with a parents query, keeping files and folders and skipping Docs, shortcuts, sizeless items and the trashed", async () => {
    const conn = await connection();
    const calls = stub({
      "www.googleapis.com/drive/v3/files": (u) => {
        expect(u.searchParams.get("q")).toBe("'folder-1' in parents and trashed = false");
        expect(u.searchParams.get("supportsAllDrives")).toBe("true");
        if (!u.searchParams.get("pageToken"))
          return json({
            files: [
              { id: "d1", name: "Film (2001)", mimeType: "application/vnd.google-apps.folder" },
              { id: "f1", name: "a.mp4", mimeType: "video/mp4", size: "1234", createdTime: "2020-01-02T03:04:05Z", modifiedTime: "2020-02-02T03:04:05Z" },
              { id: "g1", name: "Notes", mimeType: "application/vnd.google-apps.document" },
              { id: "s1", name: "Shortcut", mimeType: "application/vnd.google-apps.shortcut" },
              { id: "n1", name: "no size.bin", mimeType: "application/octet-stream" },
            ],
            nextPageToken: "p2",
          });
        return json({ files: [{ id: "f2", name: "b.mp4", mimeType: "video/mp4", size: "5" }] });
      },
    });
    const entries = await createGoogleDriveProvider(conn.id).listFolder("folder-1");
    expect(entries.map((e) => [e.id, e.name, e.kind, e.sizeBytes])).toEqual([["d1", "Film (2001)", "folder", undefined], ["f1", "a.mp4", "file", 1234], ["f2", "b.mp4", "file", 5]]);
    expect(entries[1].createdAt?.toISOString()).toBe("2020-01-02T03:04:05.000Z");
    expect(hdr(calls[0].init).Authorization).toBe("Bearer access-1");
    expect(calls).toHaveLength(2);
  });
  it("escapes a quote in an id, uses 'root' for the top, and refuses a runaway listing when strict", async () => {
    const conn = await connection();
    const qs: string[] = [];
    stub({ "www.googleapis.com/drive/v3/files": (u) => (qs.push(u.searchParams.get("q")!), json({ files: Array.from({ length: 1000 }, (_, i) => ({ id: `i${i}`, name: `f${i}.mp4`, mimeType: "video/mp4", size: "1" })), nextPageToken: "more" })) });
    const p = createGoogleDriveProvider(conn.id);
    expect(p.rootFolderId?.()).toBe("root");
    await expect(p.listFolder("it's", { strict: true })).rejects.toBeInstanceOf(ListingTruncatedError);
    expect(qs[0]).toBe("'it\\'s' in parents and trashed = false");
    expect((await p.listFolder("root")).length).toBeGreaterThanOrEqual(50_000);
  });
  it("streams through Roam with a signed token for just that file, never the account's own token", async () => {
    const conn = await connection();
    const p = createGoogleDriveProvider(conn.id);
    const { url, expiresAt } = await p.getStreamingUrl("file-9");
    expect(url.startsWith("https://roam.example.com/api/storage/stream/")).toBe(true);
    expect(url).not.toContain("access-1");
    expect(verifyStreamToken(url.split("/").pop()!)).toEqual({ connectionId: conn.id, fileId: "file-9" });
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(3 * 3600_000);
    expect((await p.getFreshDownloadUrl!("file-9")).url).toContain("/api/storage/stream/");
  });
  it("reads a byte range on the server with the account token, trimming a whole-file answer", async () => {
    const conn = await connection();
    stub({
      "www.googleapis.com/drive/v3/files/a": (u, init) => {
        expect(u.searchParams.get("alt")).toBe("media");
        expect(hdr(init).Range).toBe("bytes=2-5");
        return new Response(new Uint8Array([2, 3, 4, 5]), { status: 206 });
      },
      "www.googleapis.com/drive/v3/files/whole": () => new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6]), { status: 200 }),
    });
    const p = createGoogleDriveProvider(conn.id);
    expect(Array.from(new Uint8Array(await p.fetchByteRange("a", 2, 5)))).toEqual([2, 3, 4, 5]);
    expect(Array.from(new Uint8Array(await p.fetchByteRange("whole", 1, 3)))).toEqual([1, 2, 3]);
  });
  it("says whether an item exists, and null for a folder that is gone, trashed or a file", async () => {
    const conn = await connection();
    stub({
      "www.googleapis.com/drive/v3/files/there": () => json({ id: "there", name: "f", mimeType: "video/mp4", trashed: false }),
      "www.googleapis.com/drive/v3/files/trashed": () => json({ id: "trashed", name: "f", mimeType: "application/vnd.google-apps.folder", trashed: true }),
      "www.googleapis.com/drive/v3/files/gone": () => json({ error: { code: 404 } }, 404),
      "www.googleapis.com/drive/v3/files/dir": () => json({ id: "dir", name: "Dir", mimeType: "application/vnd.google-apps.folder", trashed: false }),
    });
    const p = createGoogleDriveProvider(conn.id);
    expect([await p.fileExists!("there"), await p.fileExists!("trashed"), await p.fileExists!("gone")]).toEqual([true, false, false]);
    expect([await p.getFolder("gone"), await p.getFolder("trashed"), await p.getFolder("there")]).toEqual([null, null, null]);
    expect(await p.getFolder("dir")).toMatchObject({ id: "dir", name: "Dir", kind: "folder" });
  });
  it("fetches Google's thumbnail at the size asked for, only if it is a JPEG", async () => {
    const conn = await connection();
    const asked: string[] = [];
    stub({
      "www.googleapis.com/drive/v3/files/vid": () => json({ thumbnailLink: "https://lh3.googleusercontent.com/abc=s220" }),
      "www.googleapis.com/drive/v3/files/none": () => json({}),
      "www.googleapis.com/drive/v3/files/png": () => json({ thumbnailLink: "https://lh3.googleusercontent.com/png=s220" }),
      "lh3.googleusercontent.com/abc=s480": () => (asked.push("480"), new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/jpeg" } })),
      "lh3.googleusercontent.com/abc=s2048": () => (asked.push("2048"), new Response(new Uint8Array([3]), { headers: { "content-type": "image/jpeg" } })),
      "lh3.googleusercontent.com/png=s480": () => new Response(new Uint8Array([9]), { headers: { "content-type": "image/png" } }),
    });
    const p = createGoogleDriveProvider(conn.id);
    expect(Array.from((await p.fetchThumbnail!("vid"))!.bytes)).toEqual([1, 2]);
    expect(await p.fetchPreview!("vid")).toMatchObject({ size: 2048 });
    expect(asked).toEqual(["480", "2048"]);
    expect(await p.fetchThumbnail!("none")).toBeNull();
    expect(await p.fetchThumbnail!("png")).toBeNull();
  });
  it("waits out a rate limit, including Google's 403 form, and tries again", async () => {
    const conn = await connection();
    let n = 0;
    stub({ "www.googleapis.com/drive/v3/files/x": () => (++n === 1 ? json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, 403, { "retry-after": "0" }) : json({ id: "x", trashed: false })) });
    expect(await createGoogleDriveProvider(conn.id).fileExists!("x")).toBe(true);
    expect(n).toBe(2);
  });
  it("refreshes on expiry keeping the same refresh token, and needs sign-in when Google refuses it", async () => {
    const conn = await connection({ expiresInSeconds: 5 });
    stub({
      "oauth2.googleapis.com/token": (_u, init) => (expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe("refresh-1"), json({ access_token: "access-2", expires_in: 3600 })),
      "www.googleapis.com/drive/v3/files/x": (_u, init) => json(hdr(init).Authorization === "Bearer access-2" ? { id: "x", trashed: false } : {}, hdr(init).Authorization === "Bearer access-2" ? 200 : 401),
    });
    expect(await createGoogleDriveProvider(conn.id).fileExists!("x")).toBe(true);
    const conn2 = await connection({ expiresInSeconds: 5 });
    stub({ "oauth2.googleapis.com/token": () => new Response('{"error":"invalid_grant"}', { status: 400 }) });
    await expect(createGoogleDriveProvider(conn2.id).listFolder("root")).rejects.toBeInstanceOf(StorageReauthRequiredError);
    expect((await db.select().from(storageConnections).where(eq(storageConnections.id, conn2.id)))[0].authStatus).toBe("needs_reauth");
  });
});

describe("the stream route", () => {
  const ask = (token: string, init: RequestInit = {}, method: "GET" | "HEAD" = "GET") => (method === "GET" ? GET : HEAD)(new Request("https://roam.example.com/x", { method, ...init }), { params: Promise.resolve({ token }) } as never);

  it("passes the player's Range request to Google and back, with the account token only between Roam and Google", async () => {
    const conn = await connection();
    const calls = stub({
      "www.googleapis.com/drive/v3/files/film": (_u, init) => {
        expect(hdr(init).Range).toBe("bytes=100-199");
        return new Response(new Uint8Array(100), { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 100-199/5000", "content-length": "100", "set-cookie": "leak=1" } });
      },
    });
    const { token } = signStreamToken(conn.id, "film");
    const res = await ask(token, { headers: { Range: "bytes=100-199" } });
    expect(res.status).toBe(206);
    expect([res.headers.get("content-type"), res.headers.get("content-range"), res.headers.get("content-length"), res.headers.get("accept-ranges")]).toEqual(["video/mp4", "bytes 100-199/5000", "100", "bytes"]);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await res.arrayBuffer()).byteLength).toBe(100);
    expect(calls).toHaveLength(1);
    // HEAD answers with the headers and no body
    stub({ "www.googleapis.com/drive/v3/files/film": () => new Response(new Uint8Array(10), { status: 200, headers: { "content-type": "application/octet-stream", "content-length": "10" } }) });
    const head = await ask(token, {}, "HEAD");
    expect([head.status, head.headers.get("content-type"), (await head.arrayBuffer()).byteLength]).toEqual([200, "video/mp4", 0]);
  });
  it("is a 404 for a forged, tampered or expired token, another kind of connection, or a connection that is gone", async () => {
    const conn = await connection();
    const box = await connection({ provider: "box" });
    stub({});
    const { token } = signStreamToken(conn.id, "film");
    expect((await ask("garbage")).status).toBe(404);
    expect((await ask(token.slice(0, -2) + "xx")).status).toBe(404);
    expect((await ask(signStreamToken(conn.id, "film", Date.now() - 5 * 3600_000).token)).status).toBe(404);
    expect((await ask(signStreamToken(box.id, "film").token)).status).toBe(404);
    expect((await ask(signStreamToken("00000000-0000-4000-8000-000000000000", "film").token)).status).toBe(404);
  });
  it("hides Google's own errors, and says when an admin must sign in again", async () => {
    const conn = await connection();
    stub({ "www.googleapis.com/drive/v3/files/missing": () => new Response("secret google detail", { status: 404 }), "www.googleapis.com/drive/v3/files/range": () => new Response("x", { status: 416 }), "www.googleapis.com/drive/v3/files/boom": () => new Response("internal", { status: 500 }) });
    const missing = await ask(signStreamToken(conn.id, "missing").token);
    expect([missing.status, await missing.text()]).toEqual([404, ""]);
    expect((await ask(signStreamToken(conn.id, "range").token)).status).toBe(416);
    expect((await ask(signStreamToken(conn.id, "boom").token)).status).toBe(502);
    await db.update(storageConnections).set({ refreshTokenEncrypted: null }).where(eq(storageConnections.id, conn.id));
    expect((await ask(signStreamToken(conn.id, "film").token)).status).toBe(424);
  });
});
