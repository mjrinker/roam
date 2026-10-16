/** "More like this" and "Recommended for you": who is offered what, and why. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mediaFiles, ratings, titleCast, titleCrew, titles, watchState } from "@/lib/db/schema";
import type { AccessProfile } from "@/lib/content/access";
import type { LibraryActor } from "@/lib/content/library-access";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { recommendations, similarTitles } from "./service";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const adult: AccessProfile = { locale: "en-US", maxAge: null, allowUnrated: true };
const kid: AccessProfile = { locale: "en-US", maxAge: 7, allowUnrated: false };
let files = 0;

async function world(access: "everyone" | "restricted" = "everyone") {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  const lib = await makeLibrary(db, server.id, "movies", access);
  const actor: LibraryActor = { serverId: server.id, accountId: me.accountId, isAdmin: false };
  const viewerId = me.viewer.id;
  /** A movie with a file to play, its genres, its cast (person ids) and its director. */
  const movie = async (name: string, o: { genres?: string[]; cast?: number[]; director?: number; year?: number; playable?: boolean; imdb?: number; ratingAges?: Record<string, number> } = {}) => {
    const t = await makeTitle(db, lib.id, { kind: "movie", name, year: o.year ?? 2000, genres: o.genres ?? [], imdbRating: o.imdb ?? null, ratingAges: o.ratingAges ?? null });
    if (o.playable !== false) await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, boxFileId: `r${++files}`, filename: "m.mp4" });
    for (const [i, p] of (o.cast ?? []).entries()) await db.insert(titleCast).values({ titleId: t.id, personId: p, name: `P${p}`, position: i });
    if (o.director) await db.insert(titleCrew).values({ titleId: t.id, personId: o.director, name: `D${o.director}`, job: "Director", position: 0 });
    return t;
  };
  const rate = (titleId: string, halfStars: number, at = new Date()) => db.insert(ratings).values({ viewerId, ownerKind: "title", ownerId: titleId, halfStars, updatedAt: at });
  const finish = (titleId: string) => db.insert(watchState).values({ viewerId, ownerKind: "title", ownerId: titleId, positionSeconds: 10, durationSeconds: 10, finished: true });
  const similar = (titleId: string, viewer = adult, extra: { limit?: number; exclude?: string[] } = {}) => similarTitles(db, { actor, viewer, titleId, ...extra });
  const recs = (viewer = adult) => recommendations(db, { actor, viewer, viewerId });
  return { server, lib, me, actor, viewerId, movie, rate, finish, similar, recs };
}

describe("more like this", () => {
  it("ranks by genres, a shared director and shared cast, and leaves out unrelated titles, itself and what can't be played", async () => {
    const w = await world();
    const alien = await w.movie("Alien", { genres: ["Horror", "Sci-Fi"], cast: [1, 2], director: 10, year: 1979 });
    await w.movie("Aliens", { genres: ["Horror", "Sci-Fi", "Action"], cast: [1], director: 11, year: 1986 });
    await w.movie("The Thing", { genres: ["Horror", "Sci-Fi"], year: 1982 });
    await w.movie("Blade Runner", { genres: ["Sci-Fi"], director: 10, year: 1982 });
    await w.movie("Paddington", { genres: ["Family", "Comedy"], year: 2014 });
    await w.movie("No file yet", { genres: ["Horror", "Sci-Fi"], playable: false });
    const names = (await w.similar(alien.id)).map((r) => r.name);
    expect(names.slice(0, 3).sort()).toEqual(["Aliens", "Blade Runner", "The Thing"]); // a shared director, shared cast and the same genres all count
    expect(names).toContain("Blade Runner");
    expect(names).not.toContain("Paddington");
    expect(names).not.toContain("Alien");
    expect(names).not.toContain("No file yet");
  });

  it("only offers films for a film and shows for a show, and respects the limit and the exclusions", async () => {
    const w = await world();
    const a = await w.movie("A", { genres: ["Drama"] });
    const b = await w.movie("B", { genres: ["Drama"] });
    const c = await w.movie("C", { genres: ["Drama"] });
    const shows = await makeLibrary(db, w.server.id, "shows", "everyone");
    const s = await makeShow(db, shows.id, 1, { name: "A Show", genres: ["Drama"] });
    await db.insert(mediaFiles).values({ ownerKind: "episode", ownerId: s.episodes[0].id, boxFileId: `r${++files}`, filename: "e.mp4" });
    expect((await w.similar(a.id)).map((r) => r.name).sort()).toEqual(["B", "C"]);
    expect((await w.similar(a.id, adult, { limit: 1 }))).toHaveLength(1);
    expect((await w.similar(a.id, adult, { exclude: [b.id] })).map((r) => r.name)).toEqual(["C"]);
    expect((await w.similar(s.show.id)).map((r) => r.name)).toEqual([]);
    void c;
  });

  it("stays within what the profile may see: its age limit, library sharing, and the server", async () => {
    const w = await world();
    const base = await w.movie("Base", { genres: ["Drama"], ratingAges: { US: 0 } });
    await w.movie("Kids ok", { genres: ["Drama"], ratingAges: { US: 0 } });
    await w.movie("Grown-up", { genres: ["Drama"], ratingAges: { US: 17 } });
    expect((await w.similar(base.id, kid)).map((r) => r.name)).toEqual(["Kids ok"]);
    const other = await world();
    const stranger = await other.movie("Elsewhere", { genres: ["Drama"] });
    expect((await w.similar(base.id)).map((r) => r.id)).not.toContain(stranger.id);
    expect(await w.similar(stranger.id)).toEqual([]); // not one of this profile's titles
    const hidden = await world("restricted");
    const secret = await hidden.movie("Secret", { genres: ["Drama"] });
    expect(await hidden.similar(secret.id)).toEqual([]);
  });
});

describe("recommended for you", () => {
  it("is nothing until the profile has liked something", async () => {
    const w = await world();
    await w.movie("A", { genres: ["Drama"] });
    expect(await w.recs()).toEqual({ forYou: [], because: [] });
    const b = await w.movie("B", { genres: ["Drama"] });
    await w.rate(b.id, 5); // a middling rating says nothing
    expect((await w.recs()).forYou).toEqual([]);
  });

  it("offers unseen titles that fit what was rated highly, says why, and never what was already watched or rated", async () => {
    const w = await world();
    const loved = await w.movie("Loved horror", { genres: ["Horror", "Thriller"], cast: [1] });
    await w.rate(loved.id, 10);
    const rated = await w.movie("Rated already", { genres: ["Horror", "Thriller"] });
    await w.rate(rated.id, 8);
    const watched = await w.movie("Watched", { genres: ["Horror", "Thriller"] });
    await w.finish(watched.id);
    await w.movie("Fits", { genres: ["Horror", "Thriller"], cast: [1] });
    await w.movie("Fits less", { genres: ["Horror", "Comedy"] });
    await w.movie("Does not fit", { genres: ["Romance"] });
    const r = await w.recs();
    const names = r.forYou.map((x) => x.name);
    expect(names[0]).toBe("Fits");
    expect(names).toContain("Fits less");
    expect(names).not.toContain("Does not fit");
    for (const n of ["Rated already", "Watched", "Loved horror"]) expect(names).not.toContain(n);
    expect(r.forYou[0].because).toEqual({ id: loved.id, name: "Loved horror" });
  });

  it("counts a finished title a little, a disliked one against, and a half-watched title as already seen", async () => {
    const w = await world();
    const done = await w.movie("Finished", { genres: ["Western"] });
    await w.finish(done.id);
    const bad = await w.movie("Bad one", { genres: ["Musical"] });
    await w.rate(bad.id, 2);
    await w.movie("Another western", { genres: ["Western"] });
    await w.movie("Another musical", { genres: ["Musical"] });
    const half = await w.movie("Half way", { genres: ["Western"] });
    await db.insert(watchState).values({ viewerId: w.viewerId, ownerKind: "title", ownerId: half.id, positionSeconds: 5, durationSeconds: 100, finished: false });
    const names = (await w.recs()).forYou.map((x) => x.name);
    expect(names).toEqual(["Another western"]);
  });

  it("makes 'because you liked' rows from the latest favourites, without repeating what is above", async () => {
    const w = await world();
    const old = await w.movie("Old favourite", { genres: ["Horror"] });
    const recent = await w.movie("Recent favourite", { genres: ["Comedy"] });
    await w.rate(old.id, 10, new Date("2026-01-01"));
    await w.rate(recent.id, 9, new Date("2026-06-01"));
    for (let i = 0; i < 40; i++) await w.movie(`Horror ${i}`, { genres: ["Horror"], year: 2000 + (i % 5) });
    for (let i = 0; i < 4; i++) await w.movie(`Comedy ${i}`, { genres: ["Comedy"] });
    const r = await w.recs();
    expect(r.because.map((b) => b.title.name)).toEqual(["Recent favourite", "Old favourite"]);
    const above = new Set(r.forYou.map((x) => x.id));
    for (const row of r.because) for (const item of row.items) expect(above.has(item.id)).toBe(false);
    expect(new Set(r.because.flatMap((b) => b.items.map((i) => i.id))).size).toBe(r.because.flatMap((b) => b.items).length); // no title in two rows
  });

  it("is each profile's own: another profile's ratings do not shape it", async () => {
    const w = await world();
    const other = await makeAccount(db, "taste-other");
    await joinServer(db, w.server.id, other.accountId);
    const liked = await w.movie("Liked by the other", { genres: ["Sci-Fi"] });
    await w.movie("Sci-Fi to offer", { genres: ["Sci-Fi"] });
    await db.insert(ratings).values({ viewerId: other.viewer.id, ownerKind: "title", ownerId: liked.id, halfStars: 10 });
    expect(await w.recs()).toEqual({ forYou: [], because: [] });
    void eq; void titles;
  });
});
