/**
 * Changing files on Dropbox, OneDrive and Google Drive: what is asked for when signing in with editing, the requests each makes (against a pretend
 * service), and the gate in front of them: nothing is written unless an admin allowed it AND the sign-in was given the permission.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

process.env.TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.DROPBOX_APP_KEY = "dk";
process.env.DROPBOX_APP_SECRET = "ds";
process.env.MICROSOFT_CLIENT_ID = "mid";
process.env.MICROSOFT_CLIENT_SECRET = "msecret";
process.env.GOOGLE_CLIENT_ID = "gid";
process.env.GOOGLE_CLIENT_SECRET = "gsecret";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/storage/box", () => ({ createBoxProviderForServer: () => ({}), mintUploadToken: async () => ({}), renameBoxEntry: async () => undefined }));

import { storageConnections, type StorageProviderKind } from "@/lib/db/schema";
import { makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { createDropboxProvider, dropboxAuthorizeUrl, dropboxScopeAllowsWrite } from "./dropbox";
import { createGoogleDriveProvider, googleAuthorizeUrl, googleScopeAllowsWrite } from "./google-drive";
import { onedriveAuthorizeUrl, onedriveExchangeCode, onedriveRefresher, onedriveScopeAllowsWrite, createOneDriveProvider } from "./onedrive";
import { saveTokens } from "./oauth-tokens";
import { connectionAllowsWrite, createStorageForServer, StorageWriteNotAllowedError } from "./server-storage";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
afterEach(() => vi.unstubAllGlobals());

type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };
type Handler = (call: Call) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function stub(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: Call = { method: init.method ?? "GET", url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body };
    calls.push(call);
    const handler = routes[`${call.method} ${url.host}${url.pathname}`];
    return handler ? handler(call) : new Response(`no route ${call.method} ${url.host}${url.pathname}`, { status: 599 });
  });
  return calls;
}
const bytes = Uint8Array.from([1, 2, 3, 4]);

async function connection(provider: StorageProviderKind, over: { writeEnabled?: boolean; writeGranted?: boolean } = {}) {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const [conn] = await db.insert(storageConnections).values({ serverId: server.id, provider, label: provider, writeEnabled: over.writeEnabled ?? false, writeGranted: over.writeGranted ?? false }).returning();
  await saveTokens(conn.id, { accessToken: "tok", refreshToken: "ref", expiresInSeconds: 3600 });
  return { server, conn };
}

describe("signing in with editing", () => {
  it("Dropbox: reading only unless editing is asked for, and the permission list is named either way", () => {
    const read = new URL(dropboxAuthorizeUrl("https://r/cb", "S")).searchParams.get("scope");
    const write = new URL(dropboxAuthorizeUrl("https://r/cb", "S", { write: true })).searchParams.get("scope");
    expect(read).toBe("files.metadata.read files.content.read");
    expect(write).toBe("files.metadata.read files.content.read files.content.write");
    expect(dropboxScopeAllowsWrite(write)).toBe(true);
    expect(dropboxScopeAllowsWrite(read)).toBe(false);
    expect(dropboxScopeAllowsWrite(null)).toBe(false);
  });
  it("OneDrive: Files.Read.All, or Files.ReadWrite.All with editing; the code is traded naming that list and a refresh names none", async () => {
    expect(new URL(onedriveAuthorizeUrl("https://r/cb", "S")).searchParams.get("scope")).toBe("offline_access Files.Read.All User.Read");
    expect(new URL(onedriveAuthorizeUrl("https://r/cb", "S", { write: true })).searchParams.get("scope")).toBe("offline_access Files.ReadWrite.All User.Read");
    expect(onedriveScopeAllowsWrite("User.Read Files.ReadWrite.All openid")).toBe(true);
    expect(onedriveScopeAllowsWrite("User.Read Files.Read.All")).toBe(false);
    const bodies: string[] = [];
    stub({ "POST login.microsoftonline.com/common/oauth2/v2.0/token": ({ body }) => (bodies.push(String(body)), json({ access_token: "A", refresh_token: "R", expires_in: 3600, scope: "Files.ReadWrite.All User.Read" })) });
    const t = await onedriveExchangeCode("code", "https://r/cb", { write: true });
    expect(t.scope).toBe("Files.ReadWrite.All User.Read");
    await onedriveRefresher("R");
    expect(bodies[0]).toContain("scope=offline_access+Files.ReadWrite.All+User.Read");
    expect(bodies[1]).not.toContain("scope=");
  });
  it("Google Drive: drive.readonly, or the full drive scope with editing", () => {
    expect(new URL(googleAuthorizeUrl("https://r/cb", "S")).searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.readonly");
    const write = new URL(googleAuthorizeUrl("https://r/cb", "S", { write: true })).searchParams.get("scope");
    expect(write).toBe("https://www.googleapis.com/auth/drive");
    expect(googleScopeAllowsWrite(`${write} email`)).toBe(true);
    expect(googleScopeAllowsWrite("https://www.googleapis.com/auth/drive.readonly")).toBe(false);
  });
  it("a new sign-in decides what is allowed: one without the permission turns editing off", async () => {
    const { conn } = await connection("dropbox", { writeEnabled: true, writeGranted: true });
    await saveTokens(conn.id, { accessToken: "x", refreshToken: "y", expiresInSeconds: 60 }, null, { writeGranted: false });
    const [row] = await db.select().from(storageConnections).where(eq(storageConnections.id, conn.id));
    expect([row.writeGranted, row.writeEnabled]).toEqual([false, false]);
    await saveTokens(conn.id, { accessToken: "x", refreshToken: "y", expiresInSeconds: 60 }); // a refresh leaves it as it is
  });
});

describe("Dropbox writes", () => {
  it("replaces a file by its id, saves a file in a folder by path, renames, and finds the parent", async () => {
    const { conn } = await connection("dropbox", { writeEnabled: true, writeGranted: true });
    const calls = stub({
      "POST content.dropboxapi.com/2/files/upload": () => json({ id: "id:new" }),
      "POST api.dropboxapi.com/2/files/get_metadata": ({ body }) => {
        const path = (JSON.parse(String(body)) as { path: string }).path;
        if (path === "id:folder") return json({ ".tag": "folder", id: "id:folder", name: "A", path_display: "/Movies/A" });
        if (path === "/Movies/A") return json({ ".tag": "folder", id: "id:folder", name: "A", path_display: "/Movies/A" });
        return json({ ".tag": "file", id: "id:file", name: "x.jpg", path_display: "/Movies/A/x.jpg" });
      },
      "POST api.dropboxapi.com/2/files/move_v2": () => json({ metadata: {} }),
    });
    const p = createDropboxProvider(conn.id);
    await p.replaceFile!("id:file", bytes);
    const upload = calls.find((c) => c.url.pathname === "/2/files/upload")!;
    expect(JSON.parse(upload.headers["Dropbox-API-Arg"])).toEqual({ path: "id:file", mode: "overwrite", autorename: false, mute: true });
    expect(Array.from(upload.body as Uint8Array)).toEqual([1, 2, 3, 4]);

    expect(await p.createFile!("id:folder", "Film.mcf", bytes)).toEqual({ id: "id:new" });
    expect(JSON.parse(calls.filter((c) => c.url.pathname === "/2/files/upload")[1].headers["Dropbox-API-Arg"]).path).toBe("/Movies/A/Film.mcf");
    await p.createFile!("", "Top.mcf", bytes);
    expect(JSON.parse(calls.filter((c) => c.url.pathname === "/2/files/upload")[2].headers["Dropbox-API-Arg"]).path).toBe("/Top.mcf");

    await p.renameEntry!("file", "id:file", "y.jpg");
    expect(JSON.parse(String(calls.find((c) => c.url.pathname === "/2/files/move_v2")!.body))).toMatchObject({ from_path: "id:file", to_path: "/Movies/A/y.jpg", autorename: false });
    expect(await p.parentFolderId!("id:file")).toBe("id:folder");
  });
  it("refuses a file too big for one upload, and says what to do when the app lacks the permission", async () => {
    const { conn } = await connection("dropbox", { writeEnabled: true, writeGranted: true });
    const p = createDropboxProvider(conn.id);
    await expect(p.replaceFile!("id:f", { length: 200 * 1024 * 1024 } as Uint8Array)).rejects.toThrow(/too large/);
    stub({ "POST content.dropboxapi.com/2/files/upload": () => new Response("missing required scope 'files.content.write'", { status: 400 }) });
    await expect(p.replaceFile!("id:f", bytes)).rejects.toThrow(/files\.content\.write/);
  });
});

describe("OneDrive writes", () => {
  it("replaces a file's content, saves a file in a folder replacing one of that name, renames, and finds the parent", async () => {
    const { conn } = await connection("onedrive", { writeEnabled: true, writeGranted: true });
    const calls = stub({
      "PUT graph.microsoft.com/v1.0/me/drive/items/F1/content": () => json({ id: "F1" }),
      "PUT graph.microsoft.com/v1.0/me/drive/items/D1:/Film.mcf:/content": () => json({ id: "NEW" }),
      "PATCH graph.microsoft.com/v1.0/me/drive/items/F1": () => json({ id: "F1" }),
      "GET graph.microsoft.com/v1.0/me/drive/items/F1": () => json({ id: "F1", parentReference: { id: "D1" } }),
    });
    const p = createOneDriveProvider(conn.id);
    await p.replaceFile!("F1", bytes);
    expect(calls[0].headers["Content-Type"]).toBe("application/octet-stream");
    expect(await p.createFile!("D1", "Film.mcf", bytes)).toEqual({ id: "NEW" });
    expect(calls[1].url.search).toContain("conflictBehavior=replace");
    await p.renameEntry!("file", "F1", "y.jpg");
    expect(JSON.parse(String(calls[2].body))).toEqual({ name: "y.jpg" });
    expect(await p.parentFolderId!("F1")).toBe("D1");
    await expect(p.replaceFile!("F1", { length: 300 * 1024 * 1024 } as Uint8Array)).rejects.toThrow(/too large/);
  });
});

describe("Google Drive writes", () => {
  it("replaces content as the file's own type, replaces a same-named file or makes a new one, renames, and finds the parent", async () => {
    const { conn } = await connection("gdrive", { writeEnabled: true, writeGranted: true });
    let existing: { id: string }[] = [];
    const calls = stub({
      "GET www.googleapis.com/drive/v3/files/F1": ({ url }) => (url.searchParams.get("fields") === "parents" ? json({ parents: ["D1"] }) : json({ id: "F1", mimeType: "image/jpeg" })),
      "PATCH www.googleapis.com/upload/drive/v3/files/F1": () => json({ id: "F1" }),
      "GET www.googleapis.com/drive/v3/files": () => json({ files: existing }),
      "POST www.googleapis.com/upload/drive/v3/files": () => json({ id: "NEW" }),
      "PATCH www.googleapis.com/drive/v3/files/F1": () => json({ id: "F1" }),
    });
    const p = createGoogleDriveProvider(conn.id);
    await p.replaceFile!("F1", bytes);
    const replace = calls.find((c) => c.method === "PATCH" && c.url.pathname.startsWith("/upload"))!;
    expect(replace.headers["Content-Type"]).toBe("image/jpeg");
    expect(replace.url.search).toContain("uploadType=media");

    expect(await p.createFile!("D1", "Film.mcf", bytes)).toEqual({ id: "NEW" });
    const made = calls.find((c) => c.method === "POST")!;
    expect(made.headers["Content-Type"]).toMatch(/^multipart\/related; boundary=/);
    expect(Buffer.from(made.body as Uint8Array).toString("latin1")).toContain('"parents":["D1"]');
    existing = [{ id: "F1" }];
    expect(await p.createFile!("D1", "Film.mcf", bytes)).toEqual({ id: "F1" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1); // replaced, not made again

    await p.renameEntry!("file", "F1", "y.jpg");
    expect(JSON.parse(String(calls.find((c) => c.method === "PATCH" && !c.url.pathname.startsWith("/upload"))!.body))).toEqual({ name: "y.jpg" });
    expect(await p.parentFolderId!("F1")).toBe("D1");
  });
});

describe("the gate in front of writing", () => {
  it("allows Box always, and the rest only when an admin allowed it, the permission was given, and the sign-in is live", () => {
    const c = (provider: StorageProviderKind, writeEnabled: boolean, writeGranted: boolean, authStatus: "connected" | "needs_reauth" = "connected") => connectionAllowsWrite({ provider, writeEnabled, writeGranted, authStatus });
    expect(c("box", false, false)).toBe(true);
    expect(c("dropbox", false, false)).toBe(false);
    expect(c("dropbox", true, false)).toBe(false);
    expect(c("dropbox", false, true)).toBe(false);
    expect(c("dropbox", true, true)).toBe(true);
    expect(c("onedrive", true, true, "needs_reauth")).toBe(false);
  });

  it("refuses every write on a read-only connection without calling the provider, and does them on an allowed one", async () => {
    const closed = await connection("dropbox", { writeEnabled: false, writeGranted: true });
    const calls = stub({});
    const storage = createStorageForServer(closed.server.id);
    const id = `cn_${closed.conn.id}:id:file`;
    expect(await storage.writeAccess(id)).toBe("read-only");
    await expect(storage.replaceFile(id, bytes)).rejects.toBeInstanceOf(StorageWriteNotAllowedError);
    await expect(storage.createFile(`cn_${closed.conn.id}:id:folder`, "x", bytes)).rejects.toThrow(/read-only/);
    await expect(storage.renameEntry("file", id, "z")).rejects.toThrow(/read-only/);
    await expect(storage.parentFolderId(id)).rejects.toThrow(/read-only/);
    expect(calls).toEqual([]);

    const open = await connection("dropbox", { writeEnabled: true, writeGranted: true });
    stub({
      "POST content.dropboxapi.com/2/files/upload": () => json({ id: "id:new" }),
      "POST api.dropboxapi.com/2/files/get_metadata": () => json({ ".tag": "folder", id: "id:folder", name: "A", path_display: "/A" }),
    });
    const s2 = createStorageForServer(open.server.id);
    expect(await s2.writeAccess(`cn_${open.conn.id}:id:file`)).toBe("ok");
    await s2.replaceFile(`cn_${open.conn.id}:id:file`, bytes);
    // What comes back is in the form this server stores.
    expect(await s2.createFile(`cn_${open.conn.id}:id:folder`, "Film.mcf", bytes)).toEqual({ id: `cn_${open.conn.id}:id:new` });
  });

  it("says a storage that can't change files can't, and treats an unknown connection as read-only", async () => {
    const { server } = await connection("dropbox");
    const storage = createStorageForServer(server.id);
    expect(await storage.writeAccess("cn_00000000-0000-4000-8000-000000000000:x")).toBe("read-only");
  });
});
