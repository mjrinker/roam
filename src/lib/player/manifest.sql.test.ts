/** The play manifest for libraries of phone videos: Box's browser-friendly version first, the original as the fallback. */
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  browser: null as { url: string; expiresAt: Date } | null | "throw",
  calls: [] as string[],
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/storage/box", () => ({
  createBoxProviderForServer: () => ({
    getStreamingUrl: async (id: string) => (h.calls.push(`original:${id}`), { url: `https://orig/${id}`, expiresAt: new Date(Date.now() + 60_000) }),
    getBrowserVideoUrl: async (id: string) => {
      h.calls.push(`browser:${id}`);
      if (h.browser === "throw") throw new Error("Box: boom");
      return h.browser;
    },
  }),
}));

import { mediaFiles } from "@/lib/db/schema";
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
