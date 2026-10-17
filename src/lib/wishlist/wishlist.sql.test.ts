/** The shared wishlist: adding, wanting, claiming, and who may change what. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { viewers, wishlistItems, wishlistVotes } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { cleanPosterUrl, tidy, wishKey } from "./rules";
import { addWish, changeStatus, listWishes, removeWish, setNote, setWant } from "./service";

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
  const admin = await makeAccount(db, `wadmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const a = await makeAccount(db, `wa${++n}`);
  const b = await makeAccount(db, `wb${++n}`);
  await joinServer(db, server.id, a.accountId);
  await joinServer(db, server.id, b.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const scope = (accountId: string, viewer = adult) => ({ serverId: server.id, actor: { serverId: server.id, accountId, isAdmin: false } as LibraryActor, viewer, accountId });
  const list = (accountId: string, isAdmin = false, viewer = adult) => listWishes(db, { ...scope(accountId, viewer), isAdmin });
  return { server, admin, a, b, movies, scope, list };
}

describe("the rules", () => {
  it("compares titles without case, accents, punctuation or a leading article", () => {
    expect(wishKey("The Lord of the Rings: The Two Towers")).toBe(wishKey("lord of the rings the two towers"));
    expect(wishKey("Amélie")).toBe("amelie");
    expect(wishKey("Fast & Furious")).toBe(wishKey("Fast and Furious"));
    expect(wishKey("   ")).toBe("");
  });
  it("only lets a TMDB picture address through", () => {
    expect(cleanPosterUrl("https://image.tmdb.org/t/p/w342/abc123.jpg")).toBe("https://image.tmdb.org/t/p/w342/abc123.jpg");
    for (const bad of ["http://image.tmdb.org/t/p/w342/a.jpg", "https://evil.example/t/p/w342/a.jpg", "https://image.tmdb.org/t/p/original/a.jpg", "https://image.tmdb.org/t/p/w342/../a.jpg", null, 5]) expect(cleanPosterUrl(bad)).toBeNull();
  });
  it("tidies text", () => {
    expect(tidy("  a \n  b\u0000c ", 10)).toBe("a b c");
    expect(tidy("x".repeat(50), 5)).toBe("xxxxx");
    expect(tidy("   ", 5)).toBeNull();
    expect(tidy(7, 5)).toBeNull();
  });
});

describe("adding wishes", () => {
  it("adds a movie, with the household as its first want", async () => {
    const w = await world();
    const r = await addWish(db, w.scope(w.a.accountId), { kind: "movie", title: "  Heat ", year: 1995, tmdbId: 949, posterUrl: "https://image.tmdb.org/t/p/w342/h.jpg", overview: "A crew.", note: "the director's cut" });
    expect(r).toMatchObject({ ok: true, value: { joined: false } });
    const [item] = await w.list(w.a.accountId);
    expect(item).toMatchObject({ kind: "movie", title: "Heat", year: 1995, tmdbId: 949, status: "wanted", wants: 1, iWant: true, canRemove: true, note: "the director's cut", onServer: null });
    expect(item.posterUrl).toBe("https://image.tmdb.org/t/p/w342/h.jpg");
  });

  it("drops a picture that is not TMDB's, and a TMDB id on something that is not a movie or show", async () => {
    const w = await world();
    await addWish(db, w.scope(w.a.accountId), { kind: "movie", title: "A", tmdbId: 1, posterUrl: "https://evil.example/x.jpg" });
    await addWish(db, w.scope(w.a.accountId), { kind: "audiobook", title: "B", creator: "Someone", tmdbId: 5, posterUrl: "https://image.tmdb.org/t/p/w342/x.jpg" });
    const items = await w.list(w.a.accountId);
    expect(items.find((i) => i.title === "A")?.posterUrl).toBeNull();
    expect(items.find((i) => i.title === "B")).toMatchObject({ tmdbId: null, posterUrl: null, creator: "Someone" });
  });

  it("makes asking for something already listed a want instead of a second entry", async () => {
    const w = await world();
    const first = await addWish(db, w.scope(w.a.accountId), { kind: "audiobook", title: "The Hobbit", creator: "Tolkien" });
    const second = await addWish(db, w.scope(w.b.accountId), { kind: "audiobook", title: "hobbit" });
    expect(first.ok && second.ok && first.value.id === second.value.id && second.value.joined).toBe(true);
    const items = await w.list(w.b.accountId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ wants: 2, iWant: true });
    expect((await w.list(w.a.accountId))[0].canRemove).toBe(true);
    expect(items[0].canRemove).toBe(false); // b joined; a asked
  });

  it("refuses a movie that is already on the server for this profile, but not one it cannot see", async () => {
    const w = await world();
    const here = await makeTitle(db, w.movies.id, { kind: "movie", name: "Here", tmdbId: 111 }, { files: true });
    const r = await addWish(db, w.scope(w.a.accountId), { kind: "movie", title: "Here", tmdbId: 111 });
    expect(r).toMatchObject({ ok: false, status: 409, titleId: here.id });
    const kid: AccessProfile = { locale: "en-US", maxAge: 7, allowUnrated: false };
    const hiddenFromKid = await makeTitle(db, w.movies.id, { kind: "movie", name: "Adult", tmdbId: 222, ratingAges: { US: 17 } }, { files: true });
    expect(hiddenFromKid.id).toBeTruthy();
    expect(await addWish(db, w.scope(w.a.accountId, kid), { kind: "movie", title: "Adult", tmdbId: 222 })).toMatchObject({ ok: true }); // not leaked
    const noFile = await makeTitle(db, w.movies.id, { kind: "movie", name: "Empty", tmdbId: 333 }, { files: false });
    expect(noFile.id).toBeTruthy();
    expect(await addWish(db, w.scope(w.a.accountId), { kind: "movie", title: "Empty", tmdbId: 333 })).toMatchObject({ ok: true }); // nothing to play: still wanted
  });

  it("shows a listed movie as on the server once it arrives", async () => {
    const w = await world();
    await addWish(db, w.scope(w.a.accountId), { kind: "movie", title: "Later", tmdbId: 444 });
    expect((await w.list(w.a.accountId))[0].onServer).toBeNull();
    const t = await makeTitle(db, w.movies.id, { kind: "movie", name: "Later", tmdbId: 444 }, { files: true });
    expect((await w.list(w.a.accountId))[0].onServer).toEqual({ titleId: t.id });
  });

  it("refuses blanks, odd kinds, a full list and a household with too many open", async () => {
    const w = await world();
    expect(await addWish(db, w.scope(w.a.accountId), { kind: "movie", title: "   " })).toMatchObject({ ok: false, status: 400 });
    expect(await addWish(db, w.scope(w.a.accountId), { kind: "game", title: "Zelda" })).toMatchObject({ ok: false, status: 400 });
    expect(await addWish(db, w.scope(w.a.accountId), { kind: "other", title: "!!!" })).toMatchObject({ ok: false, status: 400 });
    for (let i = 0; i < 100; i++) await addWish(db, w.scope(w.a.accountId), { kind: "other", title: `Thing ${i}` });
    expect(await addWish(db, w.scope(w.a.accountId), { kind: "other", title: "One more" })).toMatchObject({ ok: false, status: 400 });
    expect(await addWish(db, w.scope(w.b.accountId), { kind: "other", title: "One more" })).toMatchObject({ ok: true }); // another household is fine
  });
});

describe("wanting, claiming and finishing", () => {
  it("lets households want and stop wanting; a wish nobody wants goes away; the most wanted is first", async () => {
    const w = await world();
    const x = await addWish(db, w.scope(w.a.accountId), { kind: "show", title: "Show X" });
    const y = await addWish(db, w.scope(w.a.accountId), { kind: "show", title: "Show Y" });
    if (!x.ok || !y.ok) throw new Error("x");
    await setWant(db, w.server.id, w.b.accountId, y.value.id, true);
    expect((await w.list(w.a.accountId)).map((i) => [i.title, i.wants])).toEqual([["Show Y", 2], ["Show X", 1]]);
    expect(await setWant(db, w.server.id, w.b.accountId, y.value.id, false)).toMatchObject({ ok: true, value: { wants: 1 } });
    expect(await setWant(db, w.server.id, w.a.accountId, x.value.id, false)).toMatchObject({ ok: true, value: { wants: 0 } });
    expect((await w.list(w.a.accountId)).map((i) => i.title)).toEqual(["Show Y"]);
    expect(await setWant(db, w.server.id, w.a.accountId, "123e4567-e89b-42d3-a456-426614174000", true)).toMatchObject({ ok: false, status: 404 });
    const other = await world();
    expect(await setWant(db, other.server.id, other.a.accountId, y.value.id, true)).toMatchObject({ ok: false, status: 404 }); // another server's wish
  });

  it("lets one household say it will buy it, shows who, and lets only them or the admin undo or finish it", async () => {
    const w = await world();
    const r = await addWish(db, w.scope(w.a.accountId), { kind: "album", title: "Rumours", creator: "Fleetwood Mac" });
    if (!r.ok) throw new Error("x");
    const id = r.value.id;
    expect(await changeStatus(db, w.server.id, w.b.accountId, false, id, "claim")).toMatchObject({ ok: true, value: { status: "claimed" } });
    expect(await changeStatus(db, w.server.id, w.a.accountId, false, id, "claim")).toMatchObject({ ok: false, status: 409 });
    const seen = (await w.list(w.a.accountId))[0];
    expect(seen).toMatchObject({ status: "claimed", claimedByMe: false });
    expect(seen.claimedByName).toBeTruthy();
    expect((await w.list(w.b.accountId))[0].claimedByMe).toBe(true);
    expect(await changeStatus(db, w.server.id, w.a.accountId, false, id, "unclaim")).toMatchObject({ ok: false, status: 403 });
    expect(await changeStatus(db, w.server.id, w.a.accountId, false, id, "got")).toMatchObject({ ok: false, status: 403 });
    expect(await changeStatus(db, w.server.id, w.admin.accountId, true, id, "unclaim")).toMatchObject({ ok: true, value: { status: "wanted" } });
    await changeStatus(db, w.server.id, w.b.accountId, false, id, "claim");
    expect(await changeStatus(db, w.server.id, w.b.accountId, false, id, "got")).toMatchObject({ ok: true, value: { status: "got" } });
    expect(await changeStatus(db, w.server.id, w.a.accountId, false, id, "claim")).toMatchObject({ ok: false, status: 409 });
    expect(await changeStatus(db, w.server.id, w.a.accountId, false, id, "reopen")).toMatchObject({ ok: false, status: 403 });
    expect(await changeStatus(db, w.server.id, w.admin.accountId, true, id, "reopen")).toMatchObject({ ok: true, value: { status: "wanted" } });
  });

  it("puts what is got last, and wanting something already got puts it back on the list", async () => {
    const w = await world();
    const x = await addWish(db, w.scope(w.a.accountId), { kind: "movie", title: "Old" });
    await addWish(db, w.scope(w.a.accountId), { kind: "movie", title: "New" });
    if (!x.ok) throw new Error("x");
    await changeStatus(db, w.server.id, w.admin.accountId, true, x.value.id, "got");
    expect((await w.list(w.a.accountId)).map((i) => [i.title, i.status])).toEqual([["New", "wanted"], ["Old", "got"]]);
    const again = await addWish(db, w.scope(w.b.accountId), { kind: "movie", title: "Old" });
    expect(again).toMatchObject({ ok: true, value: { joined: true } });
    expect((await w.list(w.a.accountId)).find((i) => i.title === "Old")?.status).toBe("wanted");
  });

  it("lets only the household that asked, or the admin, take a wish off or change its note", async () => {
    const w = await world();
    const r = await addWish(db, w.scope(w.a.accountId), { kind: "book", title: "Dune", note: "paperback" });
    if (!r.ok) throw new Error("x");
    expect(await removeWish(db, w.server.id, w.b.accountId, false, r.value.id)).toMatchObject({ ok: false, status: 403 });
    expect(await setNote(db, w.server.id, w.b.accountId, false, r.value.id, "hardback")).toMatchObject({ ok: false, status: 403 });
    expect(await setNote(db, w.server.id, w.a.accountId, false, r.value.id, "  hardcover  ")).toMatchObject({ ok: true, value: { note: "hardcover" } });
    expect(await setNote(db, w.server.id, w.admin.accountId, true, r.value.id, "")).toMatchObject({ ok: true, value: { note: null } });
    expect(await removeWish(db, w.server.id, w.a.accountId, false, r.value.id)).toMatchObject({ ok: true });
    expect(await db.select().from(wishlistItems).where(eq(wishlistItems.serverId, w.server.id))).toEqual([]);
    expect(await db.select().from(wishlistVotes)).toEqual(expect.not.arrayContaining([expect.objectContaining({ wishId: r.value.id })]));
    expect(await removeWish(db, w.server.id, w.admin.accountId, true, r.value.id)).toMatchObject({ ok: false, status: 404 });
  });

  it("names the households that want it only as they let their name be shown", async () => {
    const w = await world();
    const r = await addWish(db, w.scope(w.a.accountId), { kind: "movie", title: "Shared" });
    if (!r.ok) throw new Error("x");
    await setWant(db, w.server.id, w.b.accountId, r.value.id, true);
    await db.update(viewers).set({ name: "Ann", visibleOnServer: true }).where(eq(viewers.id, w.a.viewer.id));
    await db.update(viewers).set({ name: "Bob", visibleOnServer: false }).where(eq(viewers.id, w.b.viewer.id));
    const [item] = await w.list(w.b.accountId);
    expect(item.wants).toBe(2);
    expect(item.wantedBy).toEqual(["Ann"]); // Bob's household counts, but is not named
  });

  it("keeps each server's wishlist apart", async () => {
    const w = await world();
    const x = await world();
    await addWish(db, x.scope(x.a.accountId), { kind: "movie", title: "Elsewhere" });
    expect(await w.list(w.a.accountId)).toEqual([]);
  });
});
