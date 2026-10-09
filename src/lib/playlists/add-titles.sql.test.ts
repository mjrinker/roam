/** Adding many titles at once (the ones selected on a library page). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { playlistItems, viewers } from "@/lib/db/schema";
import { addTitles, MAX_TITLES_PER_ADD } from "./item-service";
import { listVisibleItems } from "./items";
import { addItem, addMember, createTestDb, joinServer, makeAccount, makeLibrary, makePlaylist, makeServer, makeTitle, type TestDb } from "./test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

async function world() {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  const lib = await makeLibrary(db, server.id, "movies", "everyone");
  const playlist = await makePlaylist(db, { serverId: server.id, ownerViewerId: me.viewer.id, name: "Mine" });
  const film = (name: string, over: Partial<Parameters<typeof makeTitle>[2]> = {}) => makeTitle(db, lib.id, { kind: "movie", name, ...over });
  return { server, me, lib, playlist, film };
}
const names = async (w: Awaited<ReturnType<typeof world>>) =>
  (await listVisibleItems(db, { playlistId: w.playlist.id, lib: { serverId: w.server.id, accountId: w.me.accountId, isAdmin: false }, viewer: { locale: "en-US", maxAge: null, allowUnrated: true } })).items.map((i) => i.name);

describe("addTitles", () => {
  it("adds the titles in the order given, after what is already there, counting ones already in", async () => {
    const w = await world();
    const [a, b, c, d] = [await w.film("A"), await w.film("B"), await w.film("C"), await w.film("D")];
    await addItem(db, w.playlist.id, { titleId: c.id }, 1024);
    const r = await addTitles(db, { playlistId: w.playlist.id, viewerId: w.me.viewer.id, titleIds: [d.id, a.id, c.id, b.id] });
    expect(r).toEqual({ ok: true, value: { added: 3, alreadyThere: 1, unavailable: 0 } });
    expect(await names(w)).toEqual(["C", "D", "A", "B"]);
    expect(await addTitles(db, { playlistId: w.playlist.id, viewerId: w.me.viewer.id, titleIds: [a.id, b.id] })).toEqual({ ok: true, value: { added: 0, alreadyThere: 2, unavailable: 0 } });
  });
  it("ignores repeats in the request, and counts ones this profile can't add (another server's, hidden by an age limit, not a title) as unavailable", async () => {
    const w = await world();
    const ok = await w.film("Fine", { ratingAges: { ANY: 0 } });
    const adult = await w.film("Adult", { ratingAges: { ANY: 17 } });
    const other = await world();
    const theirs = await other.film("Theirs");
    await db.update(viewers).set({ maxAge: 7, allowUnrated: false }).where(eq(viewers.id, w.me.viewer.id));
    const r = await addTitles(db, { playlistId: w.playlist.id, viewerId: w.me.viewer.id, titleIds: [ok.id, ok.id, adult.id, theirs.id, "00000000-0000-4000-8000-0000000000aa"] });
    expect(r).toEqual({ ok: true, value: { added: 1, alreadyThere: 0, unavailable: 3 } });
    expect(await names(w)).toEqual(["Fine"]);
  });
  it("is refused for a viewer-only member and a stranger, and adds nothing", async () => {
    const w = await world();
    const a = await w.film("A");
    const friend = await makeAccount(db, "friend");
    await joinServer(db, w.server.id, friend.accountId);
    await addMember(db, w.playlist.id, friend.viewer.id, "viewer");
    expect(await addTitles(db, { playlistId: w.playlist.id, viewerId: friend.viewer.id, titleIds: [a.id] })).toMatchObject({ ok: false, status: 403 });
    const stranger = await makeAccount(db, "stranger");
    expect(await addTitles(db, { playlistId: w.playlist.id, viewerId: stranger.viewer.id, titleIds: [a.id] })).toMatchObject({ ok: false, status: 404 });
    expect(await db.select().from(playlistItems).where(eq(playlistItems.playlistId, w.playlist.id))).toHaveLength(0);
  });
  it("lets an editor add, and takes at most the per-add limit in one go", async () => {
    const w = await world();
    const editor = await makeAccount(db, "editor");
    await joinServer(db, w.server.id, editor.accountId);
    await addMember(db, w.playlist.id, editor.viewer.id, "editor");
    const many = [];
    for (let i = 0; i < MAX_TITLES_PER_ADD + 3; i++) many.push((await w.film(`F${i}`)).id);
    const r = await addTitles(db, { playlistId: w.playlist.id, viewerId: editor.viewer.id, titleIds: many });
    expect(r).toEqual({ ok: true, value: { added: MAX_TITLES_PER_ADD, alreadyThere: 0, unavailable: 0 } });
  });
});
