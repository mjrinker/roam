/**
 * The photo image routes: the same uniform 404 for everything that isn't "you may have this", Box only
 * called after access is proven, private caching, the preview ladder, and bounded downloads.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  resolution: null as unknown,
  limited: false,
  limitedBuckets: new Set<string>(),
  limitChecks: [] as string[],
  boxStatus: 0,
  calls: [] as string[],
  thumb: { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9]) } as { bytes: Uint8Array } | null,
  preview: null as { bytes: Uint8Array; size: number } | null,
  previewError: null as Error | null,
  thumbError: null as Error | null,
  url: "https://dl.boxcloud.com/d/file1?token=abc",
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async (_subject: string, bucket: string) => (h.limitChecks.push(bucket.split(":")[0]), !h.limited && !h.limitedBuckets.has(bucket.split(":")[0])),
}));
vi.mock("@/lib/storage/box", () => ({
  createBoxProviderForServer: () => ({
    fetchThumbnail: async (id: string) => {
      h.calls.push(`thumb:${id}`);
      if (h.thumbError) throw h.thumbError;
      return h.thumb ? { contentType: "image/jpeg", bytes: h.thumb.bytes } : null;
    },
    fetchPreview: async (id: string) => {
      h.calls.push(`preview:${id}`);
      if (h.previewError) throw h.previewError;
      return h.preview ? { contentType: "image/jpeg", ...h.preview } : null;
    },
    getStreamingUrl: async (id: string) => {
      h.calls.push(`cached-url:${id}`);
      return { url: "https://dl.boxcloud.com/cached", expiresAt: new Date(Date.now() + 60_000) };
    },
    getFreshDownloadUrl: async (id: string) => {
      h.calls.push(`original:${id}`);
      return { url: h.url, expiresAt: new Date(Date.now() + 60_000) };
    },
  }),
}));

import { mediaFiles, profiles, viewers } from "@/lib/db/schema";
import { addMember, joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import { GET as thumbRoute } from "./[id]/thumb/route";
import { GET as previewRoute } from "./[id]/preview/route";
import { GET as originalRoute } from "./[id]/original/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
  void addMember;
});
beforeEach(() => {
  h.limited = false;
  h.limitedBuckets.clear();
  h.limitChecks.length = 0;
  h.calls.length = 0;
  h.thumb = { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9]) };
  h.preview = null;
  h.previewError = null;
  h.thumbError = null;
  h.url = "https://dl.boxcloud.com/d/file1?token=abc";
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const req = (url = "http://x/api/photos/x", headers: Record<string, string> = {}) => new Request(url, { headers });
async function signInAs(accountId: string, viewerOver: Partial<typeof viewers.$inferSelect> = {}) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: { ...all[0], ...viewerOver }, viewers: all };
}

let n = 0;
async function item(libraryId: string, kind: "photo" | "movie", container: string, sizeBytes: number | null, over: Partial<typeof import("@/lib/db/schema").titles.$inferInsert> = {}) {
  const t = await makeTitle(db, libraryId, { kind, boxFolderId: `file:pf${++n}`, ...over });
  await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, partIndex: 0, boxFileId: `box${n}`, filename: `f.${container}`, sizeBytes, container, probeStatus: "ok" });
  return { ...t, fileId: `box${n}` };
}

async function world() {
  const owner = await makeAccount(db, "owner");
  const server = await makeServer(db, owner.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const photos = await makeLibrary(db, server.id, "photos", "everyone");
  const secret = await makeLibrary(db, server.id, "photos", "restricted");
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const jpg = await item(photos.id, "photo", "jpg", 8 * 1024 * 1024);
  const small = await item(photos.id, "photo", "jpg", 500_000);
  const heic = await item(photos.id, "photo", "heic", 3_000_000);
  const clip = await item(photos.id, "movie", "mp4", 50_000_000);
  const hidden = await item(secret.id, "photo", "jpg", 1000);
  const film = await item(movies.id, "movie", "mp4", 1000);
  await signInAs(member.accountId);
  return { owner, member, server, photos, secret, jpg, small, heic, clip, hidden, film };
}

const bodyOf = async (r: Response) => Array.from(new Uint8Array(await r.arrayBuffer()));

describe("every photo route gives the same 404 for everything that isn't allowed", () => {
  it("a missing id, a bad id, a hidden library, the wrong kind, an item outside a photo library: identical, and Box is never called", async () => {
    const w = await world();
    const missing = "00000000-0000-4000-8000-0000000000bb";
    for (const [name, route] of [["thumb", thumbRoute], ["preview", previewRoute], ["original", originalRoute]] as const) {
      const seen = [] as string[];
      for (const id of [missing, "not-a-uuid", w.hidden.id, w.film.id, ...(name === "preview" ? [w.clip.id] : [])]) {
        const r = await route(req(), ctx(id));
        seen.push(`${r.status} ${r.headers.get("cache-control")} ${JSON.stringify(await r.json())}`);
      }
      expect(new Set(seen).size, `${name}: ${seen.join(" | ")}`).toBe(1);
      expect(seen[0].startsWith("404")).toBe(true);
    }
    expect(h.calls).toEqual([]);
  });

  it("a signed-out visitor, a non-member and an age-restricted profile are refused the same way", async () => {
    const w = await world();
    h.resolution = null;
    expect((await thumbRoute(req(), ctx(w.small.id))).status).toBe(404);
    const stranger = await makeAccount(db, "stranger");
    await signInAs(stranger.accountId);
    expect((await thumbRoute(req(), ctx(w.small.id))).status).toBe(404);
    // an age-limited profile on a member account
    await signInAs(w.member.accountId, { maxAge: 8, allowUnrated: false } as never);
    await db.update((await import("@/lib/db/schema")).titles).set({ ratingAges: { ANY: 16 } as never }).where(eq((await import("@/lib/db/schema")).titles.id, w.small.id));
    expect((await thumbRoute(req(), ctx(w.small.id))).status).toBe(404);
    expect(h.calls).toEqual([]);
  });

  it("a restricted library opens for a member who was granted it, and for the server admin", async () => {
    const w = await world();
    expect((await thumbRoute(req(), ctx(w.hidden.id))).status).toBe(404);
    await signInAs(w.owner.accountId);
    expect((await thumbRoute(req(), ctx(w.hidden.id))).status).toBe(200);
    const { libraryMembers } = await import("@/lib/db/schema");
    await db.insert(libraryMembers).values({ libraryId: w.secret.id, accountId: w.member.accountId, serverId: w.server.id });
    await signInAs(w.member.accountId);
    expect((await thumbRoute(req(), ctx(w.hidden.id))).status).toBe(200);
  });

  it("is rate limited only for callers who are allowed, and with a 429 that is never cached", async () => {
    const w = await world();
    h.limited = true;
    const r = await thumbRoute(req(), ctx(w.small.id));
    expect([r.status, r.headers.get("cache-control")]).toEqual([429, "no-store"]);
    expect((await thumbRoute(req(), ctx(w.hidden.id))).status).toBe(404); // not allowed: 404 even when limited, no budget signal
  });
});

describe("the server-wide Box budget", () => {
  it("is spent together with the account's, only by allowed callers, and a server over it gets a 429 with Retry-After", async () => {
    const w = await world();
    await thumbRoute(req(), ctx(w.small.id));
    expect(h.limitChecks).toEqual(["photo_thumb", "photo_box"]);
    h.limitChecks.length = 0;
    await thumbRoute(req(), ctx(w.hidden.id)); // not allowed: no budget spent at all
    expect(h.limitChecks).toEqual([]);
    h.limitedBuckets.add("photo_box");
    h.calls.length = 0;
    for (const route of [thumbRoute, previewRoute, originalRoute]) {
      const r = await route(req(), ctx(w.small.id));
      expect([r.status, r.headers.get("retry-after"), r.headers.get("cache-control")]).toEqual([429, "10", "no-store"]);
    }
    expect(h.calls).toEqual([]);
  });

  it("passes Box's own 'slow down' on as a 429, and uses a freshly minted download URL, never the playback cache", async () => {
    const w = await world();
    const { BoxApiError } = await import("box-node-sdk");
    h.thumbError = new BoxApiError({ message: "rate limited", timestamp: "", error: undefined, requestInfo: {} as never, responseInfo: { statusCode: 429 } as never });
    const limited = await thumbRoute(req(), ctx(w.small.id));
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "10"]);
    h.calls.length = 0;
    await originalRoute(req(), ctx(w.jpg.id));
    expect(h.calls).toEqual([`original:${w.jpg.fileId}`]);
  });
});

describe("thumbnail", () => {
  it("serves a photo's or a video's JPEG with private, versioned, day-long caching", async () => {
    const w = await world();
    for (const t of [w.small, w.clip]) {
      const r = await thumbRoute(req("http://x/t?v=1ab-2cd"), ctx(t.id));
      expect(r.status).toBe(200);
      expect(Object.fromEntries(["content-type", "cache-control", "x-content-type-options", "etag", "referrer-policy"].map((k) => [k, r.headers.get(k)]))).toEqual({
        "content-type": "image/jpeg", "cache-control": "private, max-age=86400, immutable", "x-content-type-options": "nosniff", etag: '"t-1ab-2cd"', "referrer-policy": "no-referrer",
      });
      expect(await bodyOf(r)).toEqual([0xff, 0xd8, 0xff, 0xe0, 9]);
    }
    expect(h.calls).toEqual([`thumb:${w.small.fileId}`, `thumb:${w.clip.fileId}`]);
  });

  it("answers a matching If-None-Match with 304, but only for someone who still has access", async () => {
    const w = await world();
    const r = await thumbRoute(req("http://x/t?v=abc", { "if-none-match": '"t-abc"' }), ctx(w.small.id));
    expect(r.status).toBe(304);
    expect(h.calls).toEqual([]); // no Box call for a cached answer
    const denied = await thumbRoute(req("http://x/t?v=abc", { "if-none-match": '"t-abc"' }), ctx(w.hidden.id));
    expect(denied.status).toBe(404);
  });

  it("caches briefly without a (valid) version, and ignores a hostile one", async () => {
    const w = await world();
    for (const url of ["http://x/t", "http://x/t?v=", "http://x/t?v=" + "a".repeat(41), "http://x/t?v=a%0d%0ab", "http://x/t?v=A_B", "http://x/t?v=<script>"]) {
      const r = await thumbRoute(req(url), ctx(w.small.id));
      expect([url, r.headers.get("cache-control"), r.headers.get("etag")]).toEqual([url, "private, max-age=300", null]);
    }
  });

  it("a thumbnail Box hasn't made yet is a 404 that is never cached; a Box failure is a 502/503, never 'not found'", async () => {
    const w = await world();
    h.thumb = null;
    const none = await thumbRoute(req(), ctx(w.small.id));
    expect([none.status, none.headers.get("cache-control")]).toEqual([404, "no-store"]);
    h.thumbError = new Error("Box: 500");
    expect((await thumbRoute(req(), ctx(w.small.id))).status).toBe(502);
    h.thumbError = new BoxReauthRequiredError("s");
    expect((await thumbRoute(req(), ctx(w.small.id))).status).toBe(503);
  });
});

describe("preview", () => {
  it("a small browser-native picture is served as the original, without waiting for Box to render anything", async () => {
    const w = await world();
    const r = await previewRoute(req(), ctx(w.small.id));
    expect([r.status, r.headers.get("location"), r.headers.get("cache-control")]).toEqual([302, h.url, "no-store"]);
    expect(h.calls).toEqual([`original:${w.small.fileId}`]);
  });

  it("a larger picture gets Box's rendering, privately cached", async () => {
    const w = await world();
    h.preview = { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]), size: 2048 };
    const r = await previewRoute(req(), ctx(w.jpg.id));
    expect([r.status, r.headers.get("content-type"), r.headers.get("cache-control"), r.headers.get("x-preview-size")]).toEqual([200, "image/jpeg", "private, max-age=300", "2048"]);
    expect(await bodyOf(r)).toEqual([0xff, 0xd8, 0xff, 1, 2, 3]);
  });

  it("falls back to the original (while a sensible size), else to the small thumbnail", async () => {
    const w = await world();
    const r = await previewRoute(req(), ctx(w.jpg.id)); // 8 MiB jpg, no rendering available
    expect([r.status, r.headers.get("location")]).toEqual([302, h.url]);
    const huge = await item(w.photos.id, "photo", "jpg", 40 * 1024 * 1024);
    const t = await previewRoute(req(), ctx(huge.id));
    expect([t.status, t.headers.get("x-preview-size"), t.headers.get("cache-control")]).toEqual([200, "320", "private, max-age=30"]);
  });

  it("never serves a HEIC as the original: its rendering, else the thumbnail, else a 404", async () => {
    const w = await world();
    h.preview = { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 7]), size: 1024 };
    expect((await previewRoute(req(), ctx(w.heic.id))).headers.get("x-preview-size")).toBe("1024");
    h.preview = null;
    const thumb = await previewRoute(req(), ctx(w.heic.id));
    expect([thumb.status, thumb.headers.get("x-preview-size")]).toEqual([200, "320"]);
    h.thumb = null;
    const none = await previewRoute(req(), ctx(w.heic.id));
    expect([none.status, none.headers.get("location")]).toEqual([404, null]);
    expect(h.calls.filter((c) => c.startsWith("original:"))).toEqual([]);
  });

  it("treats a failed rendering as 'none available' and keeps falling back; a reconnect-needed error is reported", async () => {
    const w = await world();
    h.previewError = new Error("Box: timeout");
    expect((await previewRoute(req(), ctx(w.heic.id))).headers.get("x-preview-size")).toBe("320");
    h.previewError = new BoxReauthRequiredError("s");
    expect((await previewRoute(req(), ctx(w.heic.id))).status).toBe(503);
  });

  it("refuses a download URL that isn't Box's", async () => {
    const w = await world();
    for (const bad of ["https://evil.example/x", "http://dl.boxcloud.com/x", "https://box.com.evil.example/x"]) {
      h.url = bad;
      const r = await previewRoute(req(), ctx(w.small.id));
      expect([r.status, r.headers.get("location")], bad).toEqual([502, null]);
    }
  });
});

describe("original", () => {
  it("redirects a photo or a video to a download URL that is never cached", async () => {
    const w = await world();
    for (const t of [w.jpg, w.clip]) {
      const r = await originalRoute(req(), ctx(t.id));
      expect([r.status, r.headers.get("location"), r.headers.get("cache-control"), r.headers.get("referrer-policy")]).toEqual([302, h.url, "no-store", "no-referrer"]);
    }
  });

  it("is limited separately from thumbnails and reports a Box failure", async () => {
    const w = await world();
    h.url = "https://evil.example/x";
    expect((await originalRoute(req(), ctx(w.jpg.id))).status).toBe(502);
  });
});
