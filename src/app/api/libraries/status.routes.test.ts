/** The admin progress route counts a video library with SQL joins and still answers the old way for other kinds. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/guards", () => ({ getCurrentServerAdmin: async () => ({ role: "admin" }) }));

import { mediaFiles } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, type TestDb } from "@/lib/playlists/test-db";
import { syncVideoDirectory } from "@/lib/scan/video-library";
import { GET } from "./[id]/status/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

describe("GET /api/libraries/[id]/status", () => {
  it("counts a video library's titles and probe states without listing ids", async () => {
    const admin = await makeAccount(db, "a");
    const server = await makeServer(db, admin.accountId);
    const lib = await makeLibrary(db, server.id, "video", "everyone");
    await syncVideoDirectory(
      lib.id,
      "p",
      "",
      ["a", "b", "c"].map((id) => ({ id: `status-${id}`, name: `${id}.mp4`, kind: "file" as const, sizeBytes: 10 }))
    );
    await db.update(mediaFiles).set({ probeStatus: "ok" }).where(eq(mediaFiles.boxFileId, "status-a"));
    await db.update(mediaFiles).set({ probeStatus: "failed" }).where(eq(mediaFiles.boxFileId, "status-b"));

    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: lib.id }) } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.titleCount).toBe(3);
    expect(body.probeCounts).toEqual({ pending: 1, ok: 1, failed: 1 });
  });

  it("still reports other library kinds as before", async () => {
    const admin = await makeAccount(db, "b");
    const server = await makeServer(db, admin.accountId);
    const movies = await makeLibrary(db, server.id, "movies", "everyone");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: movies.id }) } as never);
    expect((await res.json()).titleCount).toBe(0);
  });
});
