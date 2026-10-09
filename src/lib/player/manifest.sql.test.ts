/** The play manifest for libraries of phone videos: Box's browser-friendly version first, the original as the fallback. */
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  browser: null as { url: string; expiresAt: Date } | null | "throw",
  calls: [] as string[],
  budgets: [] as (number | undefined)[],
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/storage/box", () => ({
  createBoxProviderForServer: () => ({
    getStreamingUrl: async (id: string) => (h.calls.push(`original:${id}`), { url: `https://orig/${id}`, expiresAt: new Date(Date.now() + 60_000) }),
    getBrowserVideoUrl: async (id: string, opts?: { budgetMs?: number }) => {
      h.budgets.push(opts?.budgetMs);
      h.calls.push(`browser:${id}`);
      if (h.browser === "throw") throw new Error("Box: boom");
      return h.browser;
    },
  }),
}));

import { mediaFiles, watchState } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { buildPlayManifest } from "./manifest";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let n = 0;
async function clip() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const lib = await makeLibrary(db, server.id, "photos", "everyone");
  const t = await makeTitle(db, lib.id, { kind: "movie", boxFolderId: `file:m${++n}` });
  await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, partIndex: 0, boxFileId: `box${n}`, filename: "a.mov", sizeBytes: 1000, container: "mov", probeStatus: "ok", durationSeconds: 12 });
  return { t, server, owner, fileId: `box${n}` };
}
const build = (c: Awaited<ReturnType<typeof clip>>, prefer: boolean) => buildPlayManifest("title", c.t.id, c.owner.viewer.id, c.server.id, [], prefer);

describe("preferring the browser-friendly version", () => {
  it("plays Box's version when asked to and it is ready, with its URL and expiry", async () => {
    const c = await clip();
    const expiresAt = new Date(Date.now() + 4_000_000);
    h.browser = { url: "https://public.boxcloud.com/mp4?access_token=x", expiresAt };
    h.calls.length = 0;
    const r = await build(c, true);
    expect(r.ok && r.manifest.segments[0].url).toBe("https://public.boxcloud.com/mp4?access_token=x");
    expect(r.ok && r.manifest.expiresAt).toBe(expiresAt.toISOString());
    expect(r.ok && r.manifest.durationSeconds).toBe(12);
    expect(h.calls).toEqual([`browser:${c.fileId}`]);
  });

  it("waits long enough for Box to make it the first time, and always starts from the beginning", async () => {
    const c = await clip();
    await db.insert(watchState).values({ viewerId: c.owner.viewer.id, ownerKind: "title", ownerId: c.t.id, positionSeconds: 7, durationSeconds: 12, finished: false });
    h.browser = null;
    h.budgets.length = 0;
    const photo = await build(c, true);
    expect(photo.ok && photo.manifest.resumeSeconds).toBe(0);
    expect(h.budgets).toEqual([40_000]);
    const other = await build(c, false);
    expect(other.ok && other.manifest.resumeSeconds).toBe(7); // other libraries still resume
  });

  it("falls back to the original when Box has none yet, or when asking Box fails", async () => {
    const c = await clip();
    for (const answer of [null, "throw"] as const) {
      h.browser = answer;
      const r = await build(c, true);
      expect(r.ok && r.manifest.segments[0].url, String(answer)).toBe(`https://orig/${c.fileId}`);
    }
  });

  it("is not used for ordinary libraries: the original plays and Box is never asked", async () => {
    const c = await clip();
    h.browser = { url: "https://public.boxcloud.com/mp4?access_token=x", expiresAt: new Date(Date.now() + 4_000_000) };
    h.calls.length = 0;
    const r = await build(c, false);
    expect(r.ok && r.manifest.segments[0].url).toBe(`https://orig/${c.fileId}`);
    expect(h.calls).toEqual([`original:${c.fileId}`]);
  });
});

describe("resolution versions", () => {
  async function film(versions: { label: string; w: number; h: number; parts?: number; probed?: boolean }[]) {
    const owner = await makeAccount(db, "ov");
    const server = await makeServer(db, owner.accountId);
    const lib = await makeLibrary(db, server.id, "movies", "everyone");
    const t = await makeTitle(db, lib.id, { kind: "movie", boxFolderId: `folder:v${++n}` });
    for (const v of versions) {
      for (let p = 0; p < (v.parts ?? 1); p++) {
        await db.insert(mediaFiles).values({
          ownerKind: "title", ownerId: t.id, partIndex: p, versionLabel: v.label, boxFileId: `${v.label || "orig"}-${p}-${n}`, filename: `f-${v.label}.mp4`, sizeBytes: 1000, container: "mp4",
          probeStatus: v.probed === false ? "pending" : "ok", durationSeconds: v.probed === false ? null : 100 + p, width: v.w, height: v.h,
        });
      }
    }
    return { t, server, owner };
  }
  const play = (f: Awaited<ReturnType<typeof film>>, choice = {}) => buildPlayManifest("title", f.t.id, f.owner.viewer.id, f.server.id, [], false, choice);

  it("plays the highest version by default and offers all of them, best first, with only that version's parts", async () => {
    const f = await film([{ label: "1080p", w: 1920, h: 1080 }, { label: "4k", w: 3840, h: 2160, parts: 2 }, { label: "720p", w: 1280, h: 720 }]);
    const r = await play(f);
    expect(r.ok && r.manifest.version).toBe("4k");
    expect(r.ok && r.manifest.versions?.map((v) => [v.label, v.name])).toEqual([["4k", "4K"], ["1080p", "1080p"], ["720p", "720p"]]);
    expect(r.ok && r.manifest.segments.map((s) => s.url)).toEqual([expect.stringContaining("4k-0"), expect.stringContaining("4k-1")]);
    expect(r.ok && r.manifest.durationSeconds).toBe(201); // the 4K parts only, never added to the other versions
  });
  it("plays the version asked for, else the closest to a preferred height, else the default", async () => {
    const f = await film([{ label: "1080p", w: 1920, h: 1080 }, { label: "720p", w: 1280, h: 720 }]);
    expect((await play(f, { version: "720p" })).ok && (await play(f, { version: "720p" }))).toMatchObject({ manifest: { version: "720p", durationSeconds: 100 } });
    const closest = await play(f, { preferredHeight: 700 });
    expect(closest.ok && closest.manifest.version).toBe("720p");
    const unknown = await play(f, { version: "nope" });
    expect(unknown.ok && unknown.manifest.version).toBe("1080p");
  });
  it("leaves out a version that isn't probed yet, and still plays when only unlabelled files exist", async () => {
    const f = await film([{ label: "4k", w: 3840, h: 2160, probed: false }, { label: "1080p", w: 1920, h: 1080 }]);
    const r = await play(f);
    expect(r.ok && r.manifest.version).toBe("1080p");
    expect(r.ok && r.manifest.versions?.map((v) => v.label)).toEqual(["1080p"]);
    const plain = await film([{ label: "", w: 1280, h: 720 }]);
    const p = await play(plain);
    expect(p.ok && [p.manifest.version, p.manifest.versions?.[0].name]).toEqual(["", "720p"]);
  });
  it("is still 'not ready' when nothing is probed", async () => {
    const f = await film([{ label: "1080p", w: 1920, h: 1080, probed: false }]);
    expect((await play(f)).ok).toBe(false);
  });
});
