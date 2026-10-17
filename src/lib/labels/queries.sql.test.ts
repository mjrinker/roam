/** A profile's labels on a server: counts and titles only for what it can still see. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { titles } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { createLabel, deleteLabel, labelIdsByTitle, listLabels, renameLabel, setTitleLabel } from "./service";
import { labelWithTitles, visibleLabels } from "./queries";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const adult: AccessProfile = { locale: "en-US", maxAge: null, allowUnrated: true };
let n = 0;

async function world() {
  const admin = await makeAccount(db, `lqadmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, `lqme${++n}`);
  await joinServer(db, server.id, me.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const actor: LibraryActor = { serverId: server.id, accountId: me.accountId, isAdmin: false };
  const scope = (viewer = adult) => ({ actor, viewer, viewerId: me.viewer.id, serverId: server.id });
  const film = (name: string, over = {}, files = true) => makeTitle(db, movies.id, { kind: "movie", name, ...over }, { files });
  return { server, me, movies, shows, scope, film };
}

describe("a profile's labels on a server", () => {
  it("counts and lists only what the profile can see: not too mature, not without a file, not on another server", async () => {
    const w = await world();
    const ok = await w.film("Alpha");
    const mature = await w.film("Mature", { ratingAges: { US: 17 } });
    const bare = await w.film("No file", {}, false);
    const show = (await makeShow(db, w.shows.id, 2, { name: "Show" }, { files: true })).show;
    const elsewhere = await makeServer(db, (await makeAccount(db, `lqe${++n}`)).accountId);
    const far = await makeTitle(db, (await makeLibrary(db, elsewhere.id, "movies", "everyone")).id, { kind: "movie", name: "Faraway" }, { files: true });
    const l = await createLabel(db, w.me.viewer.id, "Weekend");
    if (!l.ok) throw new Error("x");
    for (const t of [ok, mature, bare, show, far]) await setTitleLabel(db, w.me.viewer.id, l.value.id, t.id, true);
    expect((await listLabels(db, w.me.viewer.id))[0].count).toBe(5); // the raw count, before anything is hidden
    expect(await visibleLabels(db, w.scope())).toEqual([{ id: l.value.id, name: "Weekend", count: 3 }]); // Alpha, Mature, Show
    const kid: AccessProfile = { locale: "en-US", maxAge: 13, allowUnrated: true };
    expect((await visibleLabels(db, w.scope(kid)))[0].count).toBe(2);
    const page = await labelWithTitles(db, w.scope(kid), l.value.id);
    expect(page?.titles.map((t) => t.name)).toEqual(["Alpha", "Show"]);
    expect(page?.name).toBe("Weekend");
  });

  it("is nothing for somebody else's label or an unknown one", async () => {
    const w = await world();
    const other = await makeAccount(db, `lqo${++n}`);
    await joinServer(db, w.server.id, other.accountId);
    const theirs = await createLabel(db, other.viewer.id, "Theirs");
    if (!theirs.ok) throw new Error("x");
    expect(await labelWithTitles(db, w.scope(), theirs.value.id)).toBeNull();
    expect(await labelWithTitles(db, w.scope(), "123e4567-e89b-42d3-a456-426614174000")).toBeNull();
    expect(await visibleLabels(db, w.scope())).toEqual([]);
  });
});

describe("the label service", () => {
  it("gives each title the ids of the profile's labels on it, renames, and deletes with its items", async () => {
    const w = await world();
    const a = await w.film("A");
    const b = await w.film("B");
    const one = await createLabel(db, w.me.viewer.id, "One");
    const two = await createLabel(db, w.me.viewer.id, "Two");
    if (!one.ok || !two.ok) throw new Error("x");
    await setTitleLabel(db, w.me.viewer.id, one.value.id, a.id, true);
    await setTitleLabel(db, w.me.viewer.id, two.value.id, a.id, true);
    await setTitleLabel(db, w.me.viewer.id, two.value.id, b.id, true);
    const map = await labelIdsByTitle(db, w.me.viewer.id, [a.id, b.id, "123e4567-e89b-42d3-a456-426614174000"]);
    expect([...(map.get(a.id) ?? [])].sort()).toEqual([one.value.id, two.value.id].sort());
    expect(map.get(b.id)).toEqual([two.value.id]);
    expect(map.size).toBe(2);
    expect(await renameLabel(db, w.me.viewer.id, one.value.id, "Uno")).toMatchObject({ ok: true });
    expect(await renameLabel(db, w.me.viewer.id, one.value.id, "TWO")).toMatchObject({ ok: false, status: 409 });
    expect(await deleteLabel(db, w.me.viewer.id, two.value.id)).toBe(true);
    expect([...(await labelIdsByTitle(db, w.me.viewer.id, [a.id, b.id])).entries()]).toEqual([[a.id, [one.value.id]]]);
    // deleting a title takes its labels' items with it
    await db.delete(titles).where(eq(titles.id, a.id));
    expect((await listLabels(db, w.me.viewer.id)).find((l) => l.id === one.value.id)?.count).toBe(0);
  });
});
