/** Postgres keeps microseconds; a JS cursor keeps milliseconds. Paging must still visit every row exactly once. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { listMembers } from "./member-service";
import { listPlaylists } from "./service";
import { addMember, createTestDb, joinServer, makeAccount, makePlaylist, makeServer, type TestDb } from "./test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

describe("cursor paging with microsecond timestamps", () => {
  it("pages members one at a time without repeating or skipping", async () => {
    const owner = await makeAccount(db, "owner");
    const server = await makeServer(db, owner.accountId);
    const playlist = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
    const people = [];
    for (const n of ["a", "b", "c"]) {
      const acct = await makeAccount(db, n);
      await joinServer(db, server.id, acct.accountId);
      await addMember(db, playlist.id, acct.viewer.id, "viewer", owner.viewer.id);
      people.push(acct.viewer.id);
    }
    // Distinct microsecond values inside the same millisecond.
    for (const [i, id] of people.entries()) {
      await db.execute(
        sql`update playlist_members set created_at = ${`2026-01-01T00:00:00.12345${i + 1}Z`}::timestamptz where playlist_id = ${playlist.id} and viewer_id = ${id}`
      );
    }
    const seen: string[] = [];
    let after: { createdAt: string; id: string } | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await listMembers(db, { playlistId: playlist.id, viewerId: owner.viewer.id, limit: 1, after });
      if (!r.ok) throw new Error("listMembers failed");
      seen.push(...r.value.members.map((m) => m.id));
      if (!r.value.nextCursor) break;
      after = r.value.nextCursor;
    }
    expect(seen.sort()).toEqual([...people].sort());
  });

  it("pages playlists without skipping rows that share a millisecond", async () => {
    const owner = await makeAccount(db, "owner2");
    const server = await makeServer(db, owner.accountId);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
      ids.push(p.id);
      await db.execute(sql`update playlists set updated_at = ${`2026-01-01T00:00:00.12${i + 3}9Z`}::timestamptz where id = ${p.id}`);
    }
    const seen: string[] = [];
    let after: { updatedAt: string; id: string } | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await listPlaylists(db, { serverId: server.id, viewerId: owner.viewer.id, limit: 1, after });
      if (!r.ok) throw new Error("listPlaylists failed");
      seen.push(...r.value.playlists.map((p) => p.id));
      if (!r.value.nextCursor) break;
      after = r.value.nextCursor;
    }
    expect(seen.sort()).toEqual([...ids].sort());
  });
});
