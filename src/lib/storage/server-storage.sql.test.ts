/** The per-server storage router: ids in and out, which connection each goes to, and what it refuses. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

process.env.TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.DROPBOX_APP_KEY = "k";
process.env.DROPBOX_APP_SECRET = "s";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, boxCalls: [] as string[] }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/storage/box", () => ({
  createBoxProviderForServer: (connectionId: string) => ({
    listFolder: async (id: string) => (h.boxCalls.push(`list ${connectionId} ${id}`), [{ id: "9001", name: "From Box", kind: "folder" as const }]),
    getFolder: async (id: string) => (h.boxCalls.push(`folder ${id}`), { id, name: "A Box folder", kind: "folder" as const }),
    getStreamingUrl: async (id: string) => (h.boxCalls.push(`stream ${id}`), { url: `https://box/${id}`, expiresAt: new Date() }),
    fetchByteRange: async () => new ArrayBuffer(0),
  }),
}));

import { storageConnections } from "@/lib/db/schema";
import { makeAccount, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { saveTokens } from "./oauth-tokens";
import { createStorageForServer } from "./server-storage";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
afterEach(() => vi.unstubAllGlobals());

async function world() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const [dropbox] = await db.insert(storageConnections).values({ serverId: server.id, provider: "dropbox", label: "Dropbox" }).returning();
  await saveTokens(dropbox.id, { accessToken: "a", refreshToken: "r", expiresInSeconds: 3600 });
  return { server, dropbox };
}
const dropboxApi = (routes: Record<string, (body: Record<string, unknown>) => unknown>) =>
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    const r = routes[path];
    return r ? new Response(JSON.stringify(r(init.body ? JSON.parse(String(init.body)) : {})), { status: 200 }) : new Response("no route " + path, { status: 599 });
  });

describe("a server's storage", () => {
  it("sends ids from the original connection to Box untouched, even with no row of its own", async () => {
    const w = await world();
    const storage = createStorageForServer(w.server.id);
    h.boxCalls.length = 0;
    const entries = await storage.listFolder("12345");
    expect(entries).toEqual([{ id: "9001", name: "From Box", kind: "folder" }]); // no prefix on the way out
    expect((await storage.getStreamingUrl("777")).url).toBe("https://box/777");
    expect(h.boxCalls).toEqual([`list ${w.server.id} 12345`, "stream 777"]);
    expect((await storage.connectionOf("12345"))?.provider).toBe("box");
  });
  it("sends another connection's ids to its provider, un-prefixed, and prefixes what comes back", async () => {
    const w = await world();
    const seen: unknown[] = [];
    dropboxApi({
      "/2/files/list_folder": (b) => (seen.push(b.path), { entries: [{ ".tag": "folder", id: "id:sub", name: "Sub" }, { ".tag": "file", id: "id:f", name: "f.mp4", size: 3 }], cursor: "c", has_more: false }),
      "/2/files/get_temporary_link": (b) => (seen.push(b.path), { link: "https://dl.dropboxusercontent.com/x" }),
      "/2/files/get_metadata": (b) => ({ ".tag": "folder", id: b.path, name: "Meta" }),
    });
    const storage = createStorageForServer(w.server.id);
    const top = `cn_${w.dropbox.id}:`; // the top of the Dropbox, empty path
    const entries = await storage.listFolder(top);
    expect(entries.map((e) => e.id)).toEqual([`cn_${w.dropbox.id}:id:sub`, `cn_${w.dropbox.id}:id:f`]);
    expect(seen[0]).toBe("");
    await storage.listFolder(entries[0].id);
    expect(seen[1]).toBe("id:sub");
    expect((await storage.getStreamingUrl(entries[1].id)).url).toBe("https://dl.dropboxusercontent.com/x");
    expect(seen[2]).toBe("id:f");
    expect((await storage.getFolder(entries[0].id))?.id).toBe(`cn_${w.dropbox.id}:id:sub`);
    expect((await storage.connectionOf(entries[0].id))?.label).toBe("Dropbox");
  });
  it("refuses an id on a connection that belongs to another server, or doesn't exist", async () => {
    const w = await world();
    const other = await world();
    const storage = createStorageForServer(w.server.id);
    await expect(storage.listFolder(`cn_${other.dropbox.id}:id:x`)).rejects.toThrow(/No storage connection/);
    await expect(storage.getStreamingUrl("cn_00000000-0000-4000-8000-000000000000:id:x")).rejects.toThrow(/No storage connection/);
    expect(await storage.connectionOf(`cn_${other.dropbox.id}:id:x`)).toBeNull();
  });
  it("answers 'can't say' rather than 'gone' for a provider that can't check files, and no picture for one that makes none", async () => {
    const w = await world();
    const storage = createStorageForServer(w.server.id);
    await expect(storage.fileExists!("12345")).rejects.toThrow(/can't say/);
    expect(await storage.fetchThumbnail!("12345")).toBeNull();
    expect(await storage.fetchPreview!("12345")).toBeNull();
    expect(await storage.getBrowserVideoUrl!("12345")).toBeNull();
  });
});
