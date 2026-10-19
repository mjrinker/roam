/**
 * Changing when a picture was taken: admin only; saved in Roam at once; written into a Box JPEG as a new version of the file, and only there.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  resolution: null as unknown,
  uploads: [] as { replaceFileId: string; name: string; bytes: Uint8Array }[],
  uploadFails: false,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
vi.mock("@/lib/storage/box", () => ({
  createBoxProviderForServer: () => ({ getStreamingUrl: async () => ({ url: "https://dl.boxcloud.com/d/f", expiresAt: new Date(Date.now() + 60_000) }) }),
  mintUploadToken: async () => ({ accessToken: "t", expiresAt: new Date(Date.now() + 600_000) }),
}));
vi.mock("@/lib/storage/box-sidecar", () => ({ boxParentFolderId: async () => "folder1" }));
vi.mock("@/lib/remux/remux-core.mjs", () => ({
  uploadFile: async (o: { replaceFileId: string; name: string; filePath: string }) => {
    if (h.uploadFails) throw new Error("box down");
    h.uploads.push({ replaceFileId: o.replaceFileId, name: o.name, bytes: new Uint8Array(await readFile(o.filePath)) });
    return { id: o.replaceFileId };
  },
}));

import { mediaFiles, profiles, titles, viewers } from "@/lib/db/schema";
import { addMember, joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { readImageMeta } from "@/lib/scan/image-meta";
import { PUT } from "./[id]/date/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
  void addMember;
});
beforeEach(() => {
  h.uploads.length = 0;
  h.uploadFails = false;
  vi.stubGlobal("fetch", async () => new Response(JPEG));
});

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0xff, 0xd9]);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const put = (id: string, body: unknown) => PUT(new Request("http://x", { method: "PUT", body: JSON.stringify(body) }), ctx(id));
async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}
let n = 0;
async function photo(libraryId: string, container: string, boxFileId = `box${++n}`) {
  const t = await makeTitle(db, libraryId, { kind: "photo", boxFolderId: `file:pf${++n}`, takenAt: new Date("2026-10-18T10:00:00Z"), takenAtSource: "box" });
  await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, partIndex: 0, boxFileId, filename: `f.${container}`, sizeBytes: JPEG.length, container, probeStatus: "ok" });
  return t;
}
async function world() {
  const owner = await makeAccount(db, "owner");
  const server = await makeServer(db, owner.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const library = await makeLibrary(db, server.id, "photos", "everyone");
  return { owner, member, library, jpg: await photo(library.id, "jpg"), heic: await photo(library.id, "heic"), other: await photo(library.id, "jpg", "cn_00000000-0000-4000-8000-000000000001:abc") };
}
const row = async (id: string) => (await db.select({ at: titles.takenAt, source: titles.takenAtSource }).from(titles).where(eq(titles.id, id)))[0];

describe("PUT /api/photos/[id]/date", () => {
  it("is for the admin only: anyone else gets a plain not-found and nothing changes", async () => {
    const w = await world();
    await signInAs(w.member.accountId);
    const r = await put(w.jpg.id, { takenAt: "2015-06-01T08:30" });
    expect(r.status).toBe(404);
    expect((await row(w.jpg.id)).source).toBe("box");
    expect(h.uploads).toEqual([]);
  });

  it("saves the date as a manual one and writes it into a Box JPEG as a new version of that file", async () => {
    const w = await world();
    await signInAs(w.owner.accountId);
    const r = await put(w.jpg.id, { takenAt: "2015-06-01T08:30" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ takenAt: "2015-06-01T08:30:00.000Z", file: "written" });
    expect(await row(w.jpg.id)).toEqual({ at: new Date("2015-06-01T08:30:00Z"), source: "manual" });
    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0].replaceFileId).toMatch(/^box/);
    const sent = h.uploads[0].bytes;
    expect((await readImageMeta(async (s, e) => sent.slice(s, e + 1).buffer as ArrayBuffer, sent.length)).takenAt?.toISOString()).toBe("2015-06-01T08:30:00.000Z");
    const [file] = await db.select({ size: mediaFiles.sizeBytes }).from(mediaFiles).where(eq(mediaFiles.ownerId, w.jpg.id));
    expect(file.size).toBe(sent.length);
  });

  it("keeps the date in Roam only for a format or storage it can't write to, and says so", async () => {
    const w = await world();
    await signInAs(w.owner.accountId);
    expect(await (await put(w.heic.id, { takenAt: "2015-06-01T08:30" })).json()).toMatchObject({ file: "not-jpeg" });
    expect(await (await put(w.other.id, { takenAt: "2015-06-01T08:30" })).json()).toMatchObject({ file: "not-box" });
    expect(h.uploads).toEqual([]);
    expect((await row(w.heic.id)).source).toBe("manual");
  });

  it("still saves the date when writing the file fails", async () => {
    const w = await world();
    await signInAs(w.owner.accountId);
    h.uploadFails = true;
    expect(await (await put(w.jpg.id, { takenAt: "2015-06-01T08:30" })).json()).toMatchObject({ file: "failed" });
    expect((await row(w.jpg.id)).source).toBe("manual");
  });

  it("refuses an impossible or future date", async () => {
    const w = await world();
    await signInAs(w.owner.accountId);
    for (const takenAt of ["2015-02-30T08:30", "2999-01-01T00:00", "yesterday", 5, null]) {
      expect((await put(w.jpg.id, { takenAt })).status).toBe(400);
    }
    expect((await row(w.jpg.id)).source).toBe("box");
  });
});
