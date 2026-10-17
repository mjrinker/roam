/** The duplicate-photo routes: admin only, and what they do. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, headers: {} as Record<string, string>, thumbs: new Map<string, Uint8Array>() }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.headers),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
vi.mock("@/lib/storage/server-storage", () => ({ createStorageForServer: () => ({ fetchThumbnail: async (fileId: string) => (h.thumbs.has(fileId) ? { contentType: "image/jpeg", bytes: h.thumbs.get(fileId)! } : null) }) }));

import sharp from "sharp";
import { eq } from "drizzle-orm";
import { mediaFiles, titles } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { GET as list } from "./[id]/duplicates/route";
import { POST as hash } from "./[id]/duplicates/hash/route";
import { POST as hide } from "./[id]/duplicates/hide/route";
import { POST as restore } from "./[id]/duplicates/restore/route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
  h.thumbs.clear();
});
afterEach(() => vi.unstubAllGlobals());

const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const send = (body?: unknown, url = "https://roam.example/x") => new Request(url, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};

/** A picture with a distinctive layout, as JPEG bytes. */
async function picture(variant: number, width = 240) {
  const w = width;
  const hgt = Math.round((width * 2) / 3);
  const px = Buffer.alloc(w * hgt * 3);
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 3;
    const blob = Math.hypot(x / w - (variant ? 0.25 : 0.7), y / hgt - (variant ? 0.7 : 0.3)) < 0.17 ? 255 : 0;
    const v = Math.min(255, Math.floor((x / w) * 140 + (y / hgt) * 60) + blob);
    px[o] = v; px[o + 1] = (v * 3) % 256; px[o + 2] = 255 - v;
  }
  return new Uint8Array(await sharp(px, { raw: { width: w, height: hgt, channels: 3 } }).jpeg({ quality: 85 }).toBuffer());
}

let n = 0;
async function world() {
  const admin = await makeAccount(db, `dpadmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, `dpmember${++n}`);
  await joinServer(db, server.id, member.accountId);
  const lib = await makeLibrary(db, server.id, "photos", "everyone");
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  async function photo(name: string, bytes: Uint8Array | null) {
    const [t] = await db.insert(titles).values({ libraryId: lib.id, kind: "photo", name, boxFolderId: `dp${++n}`, takenAt: new Date("2021-03-03T10:00:00Z"), folderPath: "" }).returning();
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, boxFileId: `f-${t.id}`, filename: `${name}.jpg`, sizeBytes: bytes?.length ?? 10 });
    if (bytes) h.thumbs.set(`f-${t.id}`, bytes);
    return t;
  }
  return { admin, member, server, lib, movies, photo };
}

describe("who may use the duplicate routes", () => {
  it("is for the server's admin only: members, strangers, signed-out visitors, bad ids and non-photo libraries all get nothing", async () => {
    const w = await world();
    for (const as_ of [w.member]) {
      await as(as_);
      expect((await list(send(), ctx(w.lib.id))).status).toBe(403);
      expect((await hash(send({}), ctx(w.lib.id))).status).toBe(403);
      expect((await hide(send({ keepId: w.lib.id, hideIds: [w.lib.id] }), ctx(w.lib.id))).status).toBe(403);
      expect((await restore(send({ ids: [w.lib.id] }), ctx(w.lib.id))).status).toBe(403);
    }
    await as(w.admin);
    expect((await list(send(), ctx(w.movies.id))).status).toBe(404); // not a photo library
    expect((await list(send(), ctx("nope"))).status).toBe(404);
    expect((await list(send(), ctx("123e4567-e89b-42d3-a456-426614174000"))).status).toBe(404);
    h.headers = {};
    expect((await list(send(), ctx(w.lib.id))).status).toBe(403);
    const stranger = await makeAccount(db, `dps${++n}`);
    await as(stranger);
    expect((await list(send(), ctx(w.lib.id))).status).toBe(403);
  });
});

describe("finding and hiding duplicates", () => {
  it("checks pictures in batches, then lists the groups, hides a copy, and restores it", async () => {
    const w = await world();
    await as(w.admin);
    const big = await picture(0, 240);
    const small = await picture(0, 120); // the same picture smaller
    const other = await picture(1, 240);
    const a = await w.photo("a", big);
    const b = await w.photo("b", small);
    await w.photo("c", other);
    await w.photo("no thumb", null);
    const first = await json(await hash(send({}), ctx(w.lib.id)));
    expect(first).toMatchObject({ hashed: 3, failed: 1, total: 4, checked: 3 });
    const groups = await json(await list(send(), ctx(w.lib.id)));
    expect(groups.progress).toEqual({ total: 4, checked: 3, failed: 1 });
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0].items.map((i: { id: string }) => i.id).sort()).toEqual([a.id, b.id].sort());
    const keepId = groups.groups[0].keepId as string;
    const copy = keepId === a.id ? b.id : a.id;
    const hidden = await hide(send({ keepId, hideIds: [copy] }), ctx(w.lib.id));
    expect(await json(hidden)).toEqual({ hidden: 1 });
    const after = await json(await list(send(), ctx(w.lib.id)));
    expect(after.groups).toEqual([]);
    expect(after.hidden.map((x: { id: string }) => x.id)).toEqual([copy]);
    expect(await json(await restore(send({ ids: [copy] }), ctx(w.lib.id)))).toEqual({ restored: 1 });
    expect((await json(await list(send(), ctx(w.lib.id)))).groups).toHaveLength(1);
  });

  it("answers the match setting, and refuses bad requests", async () => {
    const w = await world();
    await as(w.admin);
    expect((await list(send(undefined, "https://roam.example/x?match=exact"), ctx(w.lib.id))).status).toBe(200);
    expect((await list(send(undefined, "https://roam.example/x?match=loose"), ctx(w.lib.id))).status).toBe(200);
    expect((await hide(send({ keepId: "x", hideIds: ["y"] }), ctx(w.lib.id))).status).toBe(400);
    expect((await hide(send({ keepId: w.lib.id, hideIds: [] }), ctx(w.lib.id))).status).toBe(400);
    expect((await hide(send({ keepId: w.lib.id, hideIds: [w.lib.id], extra: 1 }), ctx(w.lib.id))).status).toBe(400);
    expect((await restore(send({ ids: [] }), ctx(w.lib.id))).status).toBe(400);
    expect((await hide(send({ keepId: "123e4567-e89b-42d3-a456-426614174000", hideIds: ["223e4567-e89b-42d3-a456-426614174000"] }), ctx(w.lib.id))).status).toBe(404);
    expect(await db.select({ id: titles.id }).from(titles).where(eq(titles.libraryId, w.lib.id))).toEqual([]);
  });
});
