/**
 * Every admin route that calls TMDB or Audible, or treats a title's box_folder_id as a Box folder, must
 * refuse a title from a file-tree library (video or audio) BEFORE any outside call. An audio file is
 * stored as an 'audiobook' title, so checking the title's own kind is not enough; these tests use one.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  calls: [] as string[],
  forbidden: (service: string) =>
    new Proxy(
      {},
      {
        get: (_t, name) =>
          typeof name === "symbol" || name === "then" || name === "__esModule"
            ? undefined
            : () => {
                h.calls.push(`${service}.${name}`);
                throw new Error(`${service} must not be called (${name})`);
              },
      }
    ),
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/guards", () => ({
  getCurrentServerAdmin: async () => ({ role: "admin", profile: { id: "p" }, viewer: { id: "v", role: "owner" } }),
  getCurrentProfile: async () => ({ id: "p" }),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
vi.mock("@/lib/tmdb/client", () => h.forbidden("TMDB"));
vi.mock("@/lib/omdb/client", () => h.forbidden("OMDb"));
vi.mock("@/lib/audible/client", () => ({
  ...(h.forbidden("Audible") as object),
  AUDIBLE_REGIONS: { us: "us" },
  AudibleRateLimitedError: class extends Error {},
  AudibleUnavailableError: class extends Error {},
}));
vi.mock("@/lib/storage/box", () => ({ createBoxProviderForServer: () => h.forbidden("Box") }));

import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { POST as matchTmdb } from "./[id]/match/route";
import { POST as matchAudible } from "./[id]/match-audible/route";
import { POST as syncRoute } from "./[id]/sync/route";
import { POST as fixAudio } from "./[id]/fix-audio/route";
import { GET as audibleSearch } from "../audiobooks/search/route";
import { syncSingleTitle } from "@/lib/scan/scanner";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

async function titleIn(kind: "video" | "audio" | "movies") {
  const admin = await makeAccount(db, "a");
  const server = await makeServer(db, admin.accountId);
  const lib = await makeLibrary(db, server.id, kind, "everyone");
  // An audio file is an 'audiobook' title; a video file is a 'movie' one.
  return makeTitle(db, lib.id, { kind: kind === "audio" ? "audiobook" : "movie", boxFolderId: `file:${Math.random()}` });
}

describe("file-tree library titles never reach an outside service or a Box folder call", () => {
  for (const kind of ["video", "audio"] as const) {
    it(`${kind}: every admin tool answers 400 and makes no outside call`, async () => {
      h.calls.length = 0;
      const t = await titleIn(kind);
      const responses = {
        tmdbMatch: await matchTmdb(new Request("http://x", json({ tmdbId: 1 })), ctx(t.id)),
        audibleMatch: await matchAudible(new Request("http://x", json({ asin: "B000000000" })), ctx(t.id)),
        resync: await syncRoute(new Request("http://x", { method: "POST" }), ctx(t.id)),
        fixAudio: await fixAudio(new Request("http://x", { method: "POST" }), ctx(t.id)),
        audibleSearch: await audibleSearch(new Request(`http://x/api/audiobooks/search?titleId=${t.id}&q=anything`)),
      };
      for (const [name, res] of Object.entries(responses)) expect(res.status, name).toBe(400);
      expect(h.calls).toEqual([]);
    });

    it(`${kind}: resyncing a single title directly is refused inside the function, not just at the route`, async () => {
      h.calls.length = 0;
      const t = await titleIn(kind);
      const result = await syncSingleTitle(t.id);
      expect(result.errors).toEqual(["Resync isn't available for items in this kind of library."]);
      expect(h.calls).toEqual([]);
    });
  }
});
