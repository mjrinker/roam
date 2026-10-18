/** What needs an admin's attention on a server. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { libraries, mediaFiles, scanRuns, storageConnections } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { healthIssueCount, serverHealth, STALE_SCAN_DAYS } from "./health";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const NOW = new Date("2026-10-18T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function server(name: string) {
  const admin = await makeAccount(db, name);
  return makeServer(db, admin.accountId);
}

describe("server health", () => {
  it("has nothing to report for a tidy server", async () => {
    const s = await server("hok");
    const lib = await makeLibrary(db, s.id, "movies");
    await db.update(libraries).set({ lastScannedAt: daysAgo(1) }).where(eq(libraries.id, lib.id));
    await makeTitle(db, lib.id, { kind: "movie", name: "Fine", metadataStatus: "matched" }, { files: true });
    const h = await serverHealth(db, s.id, NOW);
    expect(healthIssueCount(h)).toBe(0);
  });

  it("finds libraries never scanned, with errors, or stale, and storage that needs signing in", async () => {
    const s = await server("hlib");
    const never = await makeLibrary(db, s.id, "movies");
    const errors = await makeLibrary(db, s.id, "shows");
    const stale = await makeLibrary(db, s.id, "music");
    const fine = await makeLibrary(db, s.id, "movies");
    for (const [lib, at] of [[errors, daysAgo(1)], [stale, daysAgo(STALE_SCAN_DAYS + 2)], [fine, daysAgo(2)]] as const) await db.update(libraries).set({ lastScannedAt: at }).where(eq(libraries.id, lib.id));
    await db.insert(scanRuns).values({ libraryId: errors.id, trigger: "manual", startedAt: daysAgo(1), errors: ["boom", "bang"] });
    await db.insert(storageConnections).values({ serverId: s.id, provider: "dropbox", label: "Old Dropbox", authStatus: "needs_reauth" as never });
    await db.insert(storageConnections).values({ serverId: s.id, provider: "box", label: "Box", authStatus: "connected" });
    const h = await serverHealth(db, s.id, NOW);
    expect(Object.fromEntries(h.libraries.map((l) => [l.id, l.problem]))).toEqual({ [never.id]: "never_scanned", [errors.id]: "scan_errors", [stale.id]: "stale" });
    expect(h.libraries.find((l) => l.id === errors.id)?.detail).toBe("2 errors in the last scan");
    expect(h.connections.map((c) => c.label)).toEqual(["Old Dropbox"]);
  });

  it("finds movies and shows with nothing to play, unreadable files, unmatched titles and same-name duplicates", async () => {
    const s = await server("htitles");
    const lib = await makeLibrary(db, s.id, "movies");
    const shows = await makeLibrary(db, s.id, "shows");
    await db.update(libraries).set({ lastScannedAt: daysAgo(1) }).where(eq(libraries.id, lib.id));
    await db.update(libraries).set({ lastScannedAt: daysAgo(1) }).where(eq(libraries.id, shows.id));
    await makeTitle(db, lib.id, { kind: "movie", name: "Empty", year: 2001, metadataStatus: "matched" }, { files: false });
    const bad = await makeTitle(db, lib.id, { kind: "movie", name: "Broken", year: 2002, metadataStatus: "not_found" }, { files: true });
    await db.update(mediaFiles).set({ probeStatus: "failed" }).where(eq(mediaFiles.ownerId, bad.id));
    await makeTitle(db, lib.id, { kind: "movie", name: "Twin", year: 2010, metadataStatus: "matched" }, { files: true });
    await makeTitle(db, lib.id, { kind: "movie", name: "TWIN", year: 2010, metadataStatus: "matched" }, { files: true });
    await makeShow(db, shows.id, 2, { name: "Show", metadataStatus: "matched" }, { files: false });
    const h = await serverHealth(db, s.id, NOW);
    expect(h.noFile.total).toBe(2);
    expect(h.noFile.sample.map((t) => t.name).sort()).toEqual(["Empty", "Show"]);
    expect(h.unreadable.total).toBe(1);
    expect(h.unmatched).toBe(1);
    expect(h.duplicates).toHaveLength(1);
    expect(h.duplicates[0]).toMatchObject({ year: 2010, count: 2 });
    expect(healthIssueCount(h)).toBe(4); // no files, unreadable, unmatched, and the one duplicate
  });

  it("never looks at another server", async () => {
    const mine = await server("hmine");
    const theirs = await server("htheirs");
    const lib = await makeLibrary(db, theirs.id, "movies");
    await makeTitle(db, lib.id, { kind: "movie", name: "Theirs" }, { files: false });
    const h = await serverHealth(db, mine.id, NOW);
    expect(healthIssueCount(h)).toBe(0);
  });
});
