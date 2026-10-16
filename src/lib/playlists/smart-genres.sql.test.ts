import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb, autoFiles } from "./test-db";
import { visibleGenres, visibleSmartLibraries } from "./smart-genres";


autoFiles();
let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

describe("the genres to choose from", () => {
  it("are those of the titles the profile can see, once each, A to Z", async () => {
    const admin = await makeAccount(db, "genres-admin");
    const server = await makeServer(db, admin.accountId);
    const me = await makeAccount(db, "genres-me");
    await joinServer(db, server.id, me.accountId);
    const open = await makeLibrary(db, server.id, "movies", "everyone");
    const hidden = await makeLibrary(db, server.id, "movies", "restricted");
    await makeTitle(db, open.id, { kind: "movie", name: "A", genres: ["Drama", "Comedy"] });
    await makeTitle(db, open.id, { kind: "movie", name: "B", genres: ["Comedy", "Action"] });
    await makeTitle(db, open.id, { kind: "movie", name: "C", genres: [] });
    await makeTitle(db, hidden.id, { kind: "movie", name: "D", genres: ["Secret"] });
    const other = await makeServer(db, (await makeAccount(db, "genres-other")).accountId);
    const elsewhere = await makeLibrary(db, other.id, "movies", "everyone");
    await makeTitle(db, elsewhere.id, { kind: "movie", name: "E", genres: ["Elsewhere"] });
    await makeTitle(db, open.id, { kind: "movie", name: "F", genres: ["Horror"], ratingAges: { US: 17 } });
    const actor = { serverId: server.id, accountId: me.accountId, isAdmin: false };
    const adult = { locale: "en-US", maxAge: null, allowUnrated: true };
    expect(await visibleGenres(db, actor, adult)).toEqual(["Action", "Comedy", "Drama", "Horror"]);
    expect(await visibleGenres(db, { ...actor, isAdmin: true }, adult)).toEqual(["Action", "Comedy", "Drama", "Horror", "Secret"]);
    // a child's profile is not shown the names of genres only grown-up titles have
    expect(await visibleGenres(db, actor, { locale: "en-US", maxAge: 7, allowUnrated: false })).toEqual([]);
  });
});

describe("the libraries to choose from", () => {
  it("are the movie, TV, music, audio and audiobook libraries the profile can see, by name", async () => {
    const admin = await makeAccount(db, "libs-admin");
    const server = await makeServer(db, admin.accountId);
    const me = await makeAccount(db, "libs-me");
    await joinServer(db, server.id, me.accountId);
    const named = async (kind: Parameters<typeof makeLibrary>[2], name: string, access: "everyone" | "restricted" = "everyone") => {
      const lib = await makeLibrary(db, server.id, kind, access);
      const { libraries } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      await db.update(libraries).set({ name }).where(eq(libraries.id, lib.id));
      return lib;
    };
    await named("movies", "Movies");
    await named("shows", "kids tv");
    await named("music", "Music");
    await named("audiobooks", "Books on tape");
    await named("photos", "Photos");
    await named("ebooks", "Reading");
    await named("movies", "Private movies", "restricted");
    const actor = { serverId: server.id, accountId: me.accountId, isAdmin: false };
    expect((await visibleSmartLibraries(db, actor)).map((l) => [l.name, l.kind])).toEqual([["Books on tape", "audiobooks"], ["kids tv", "shows"], ["Movies", "movies"], ["Music", "music"]]);
    expect((await visibleSmartLibraries(db, { ...actor, isAdmin: true })).map((l) => l.name)).toContain("Private movies");
  });
});
