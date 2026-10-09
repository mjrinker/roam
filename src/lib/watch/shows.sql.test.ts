import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { episodes, seasons, watchState } from "@/lib/db/schema";
import { createTestDb, makeAccount, makeLibrary, makeServer, makeShow, type TestDb } from "@/lib/playlists/test-db";
import { watchedShowIds } from "./shows";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

describe("watchedShowIds", () => {
  it("counts a show as watched only when every episode, in every season, is finished by this profile", async () => {
    const admin = await makeAccount(db, "a");
    const server = await makeServer(db, admin.accountId);
    const lib = await makeLibrary(db, server.id, "shows", "everyone");
    const me = await makeAccount(db, "me");
    const other = await makeAccount(db, "other");
    const done = await makeShow(db, lib.id, 2, { name: "Done" });
    const part = await makeShow(db, lib.id, 2, { name: "Part" });
    const none = await makeShow(db, lib.id, 1, { name: "None" });
    const empty = await makeShow(db, lib.id, 0, { name: "Empty" });
    const [s2] = await db.insert(seasons).values({ titleId: done.show.id, number: 2, boxFolderId: `s2-${done.show.id}` }).returning();
    const [lateEp] = await db.insert(episodes).values({ seasonId: s2.id, number: 1 }).returning();
    const finish = (viewerId: string, id: string, finished = true) => db.insert(watchState).values({ viewerId, ownerKind: "episode", ownerId: id, positionSeconds: 0, finished });
    for (const e of [...done.episodes, lateEp]) await finish(me.viewer.id, e.id);
    await finish(me.viewer.id, part.episodes[0].id);
    await finish(me.viewer.id, part.episodes[1].id, false); // started, not finished
    await finish(other.viewer.id, none.episodes[0].id); // someone else's progress does not count
    const ids = [done.show.id, part.show.id, none.show.id, empty.show.id];
    expect([...(await watchedShowIds(db, me.viewer.id, ids))]).toEqual([done.show.id]);
    expect([...(await watchedShowIds(db, other.viewer.id, ids))]).toEqual([none.show.id]);
    expect([...(await watchedShowIds(db, me.viewer.id, []))]).toEqual([]);
  });
});
