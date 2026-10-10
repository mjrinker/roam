/** Folder browsing for video libraries: path rules, nesting, hiding, and paging on a real in-memory Postgres. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { folderLink, folderPlayableIds, folderTrail, listFolder, normalizeFolderPath, parentFolder, parseFolderSearch, parseFolderSort } from "./folder-browse";
import { naturalSortKey } from "./sort-key";
import { listAudioGroups, UNKNOWN_GROUP } from "./audio-groups";
import type { LibraryActor } from "@/lib/content/library-access";
import { createTestDb, joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const adult = { locale: "en-US", maxAge: null, allowUnrated: true };
const kid = { locale: "en-US", maxAge: 7, allowUnrated: false };

describe("normalizeFolderPath", () => {
  it("treats empty as the root and keeps ordinary nested paths", () => {
    expect(normalizeFolderPath(undefined)).toBe("");
    expect(normalizeFolderPath(null)).toBe("");
    expect(normalizeFolderPath("")).toBe("");
    expect(normalizeFolderPath("Vacations")).toBe("Vacations");
    expect(normalizeFolderPath("Vacations/2019/Beach Day")).toBe("Vacations/2019/Beach Day");
    expect(normalizeFolderPath("100%_x")).toBe("100%_x");
    expect(normalizeFolderPath(" padded /name ")).toBe(" padded /name "); // Box folder names can have edge spaces
  });

  it("rejects traversal, empty segments, slashes at the ends, backslashes and control characters", () => {
    for (const bad of ["..", "a/../b", ".", "a/./b", "/a", "a/", "a//b", "a\\b", "a\u0000b", "a\nb", "x".repeat(1025), Array(40).fill("a").join("/")]) {
      expect(normalizeFolderPath(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("folderTrail / parentFolder", () => {
  it("builds breadcrumbs and the parent path", () => {
    expect(folderTrail("")).toEqual([]);
    expect(folderTrail("A/B")).toEqual([
      { name: "A", path: "A" },
      { name: "B", path: "A/B" },
    ]);
    expect(parentFolder("")).toBeNull();
    expect(parentFolder("A")).toBe("");
    expect(parentFolder("A/B")).toBe("A");
  });
});

async function world(access: "everyone" | "restricted" = "everyone") {
  const admin = await makeAccount(db, "admin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const library = await makeLibrary(db, server.id, "video", access);
  let n = 0;
  const add = (name: string, folderPath: string, over: Record<string, unknown> = {}) =>
    makeTitle(db, library.id, { name, folderPath, boxFolderId: `file:${++n}-${Math.random()}`, ...over });
  const actor = (a: { accountId: string }, isAdmin = false): LibraryActor => ({ serverId: server.id, accountId: a.accountId, isAdmin });
  return { admin, member, server, library, add, actor };
}

describe("listFolder", () => {
  it("shows the root's videos and top-level folders, then one level at a time", async () => {
    const w = await world();
    await w.add("r1", "");
    await w.add("r2", "");
    await w.add("a1", "A");
    await w.add("ab1", "A/B");
    await w.add("ac1", "A/C");
    await w.add("abc1", "A/B/Deep");
    await w.add("d1", "D");

    const root = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "" });
    expect(root?.folders).toEqual(["A", "D"]);
    expect(root?.items.map((i) => i.name)).toEqual(["r1", "r2"]);

    const a = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "A" });
    expect(a?.folders).toEqual(["B", "C"]);
    expect(a?.items.map((i) => i.name)).toEqual(["a1"]);

    const ab = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "A/B" });
    expect(ab?.folders).toEqual(["Deep"]);
    expect(ab?.items.map((i) => i.name)).toEqual(["ab1"]);
  });

  it("doesn't confuse folders that share a prefix or contain LIKE wildcards", async () => {
    const w = await world();
    await w.add("in-a", "A");
    await w.add("in-ab", "AB");
    await w.add("pct", "100%_x");
    await w.add("other", "100Zzx"); // would match 100%_x if % and _ were treated as wildcards
    await w.add("real child", "100%_x/real");
    await w.add("impostor child", "100Zzx/impostor");
    const root = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "" });
    expect(root?.folders).toEqual(["100%_x", "100Zzx", "A", "AB"]);
    const a = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "A" });
    expect(a?.items.map((i) => i.name)).toEqual(["in-a"]); // not AB's video
    const pct = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "100%_x" });
    expect(pct?.items.map((i) => i.name)).toEqual(["pct"]);
    expect(pct?.folders).toEqual(["real"]); // not "impostor" from the look-alike folder
    expect(await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "100%" })).toBeNull();
  });

  it("never reveals a folder (or its name) that holds nothing this profile can see", async () => {
    const w = await world();
    await w.add("kids ok", "Family", { ratingAges: { ANY: 0 } });
    await w.add("adults only", "Adults", { ratingAges: { ANY: 17 } });
    await w.add("sneaky", "Family/Hidden Gems", { ratingAges: { ANY: 17 } });
    const asKid = await listFolder(db, { actor: w.actor(w.member), viewer: kid, libraryId: w.library.id, path: "" });
    expect(asKid?.folders).toEqual(["Family"]);
    const family = await listFolder(db, { actor: w.actor(w.member), viewer: kid, libraryId: w.library.id, path: "Family" });
    expect(family?.folders).toEqual([]); // "Hidden Gems" holds only an adult video
    expect(await listFolder(db, { actor: w.actor(w.member), viewer: kid, libraryId: w.library.id, path: "Adults" })).toBeNull();
    // The same hidden path answers exactly like one that never existed.
    expect(await listFolder(db, { actor: w.actor(w.member), viewer: kid, libraryId: w.library.id, path: "Nope" })).toBeNull();
    const asAdult = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "" });
    expect(asAdult?.folders).toEqual(["Adults", "Family"]);
  });

  it("answers null for a restricted library the account can't see, but not for the admin", async () => {
    const w = await world("restricted");
    await w.add("secret", "");
    expect(await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "" })).toBeNull();
    const admin = await listFolder(db, { actor: w.actor(w.admin, true), viewer: adult, libraryId: w.library.id, path: "" });
    expect(admin?.items.map((i) => i.name)).toEqual(["secret"]);
  });

  it("answers null for a library of another kind or another server, and an empty page for an empty video library", async () => {
    const w = await world();
    const movies = await makeLibrary(db, w.server.id, "movies", "everyone");
    expect(await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: movies.id, path: "" })).toBeNull();
    const other = await world();
    expect(await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: other.library.id, path: "" })).toBeNull();
    expect(await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "" })).toEqual({ folders: [], items: [], nextCursor: null });
  });

  it("lists files in natural order by file name: numbers by value, track numbers kept, whatever the title says", async () => {
    const w = await world();
    // The shown title came from tags (so it has lost its numbering); the file names carry the order.
    const put = (title: string, file: string) => w.add(title, "Album", { sortKey: naturalSortKey(file) });
    await put("Outro", "10 - Outro.mp3");
    await put("Intro", "01 - Intro.mp3");
    await put("Middle", "02 - Middle.mp3");
    await put("Episode ten", "Episode 10.mp3");
    await put("Episode two", "Episode 2.mp3");
    await put("Episode one", "Episode 1.mp3");
    const all = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "Album" });
    expect(all?.items.map((i) => i.name)).toEqual(["Intro", "Middle", "Outro", "Episode one", "Episode two", "Episode ten"]);
    // Paging follows the same order, and the page items carry no internal key.
    const first = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "Album", limit: 4 });
    const second = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "Album", limit: 4, after: first!.nextCursor });
    expect([...first!.items, ...second!.items].map((i) => i.name)).toEqual(["Intro", "Middle", "Outro", "Episode one", "Episode two", "Episode ten"]);
    expect(Object.keys(first!.items[0])).not.toContain("listKey");
  });

  it("falls back to the lowercased name for titles scanned before sort keys existed", async () => {
    const w = await world();
    await w.add("beta", "Old");
    await w.add("Alpha", "Old");
    const page = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "Old" });
    expect(page?.items.map((i) => i.name)).toEqual(["Alpha", "beta"]);
  });

  it("pages videos by name with a cursor, listing folders only on the first page", async () => {
    const w = await world();
    for (const name of ["v1", "v2", "v3", "v4", "v5"]) await w.add(name, "");
    await w.add("x", "Sub");
    const seen: string[] = [];
    let after: { key: string; id: string } | null = null;
    let first = true;
    for (let i = 0; i < 10; i++) {
      const page = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "", limit: 2, after });
      if (!page) throw new Error("null page");
      expect(page.folders).toEqual(first ? ["Sub"] : []);
      first = false;
      seen.push(...page.items.map((x) => x.name));
      if (!page.nextCursor) break;
      after = page.nextCursor;
    }
    expect(seen).toEqual(["v1", "v2", "v3", "v4", "v5"]);
  });
});

describe("sorting a folder's files", () => {
  async function album() {
    const w = await world();
    await w.add("Gamma", "Mix", { runtimeSeconds: 300, authors: ["Zed"], kind: "audiobook" });
    await w.add("Alpha", "Mix", { runtimeSeconds: 100, authors: ["Mia"], kind: "audiobook" });
    await w.add("Delta", "Mix", { runtimeSeconds: 100, authors: ["Zed", "Guest"], kind: "audiobook" });
    await w.add("Beta", "Mix", { runtimeSeconds: 200, authors: null, kind: "audiobook" });
    return w;
  }
  const names = async (w: Awaited<ReturnType<typeof world>>, sort: Parameters<typeof parseFolderSort>) => (await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "Mix", sort: parseFolderSort(...sort) }))?.items.map((i) => i.name);

  it("parses the sort from a URL, falling back to the default", () => {
    expect(parseFolderSort(undefined, undefined)).toEqual({ key: "name", dir: "asc" });
    expect(parseFolderSort("duration", undefined)).toEqual({ key: "duration", dir: "desc" });
    expect(parseFolderSort("artist", "desc")).toEqual({ key: "artist", dir: "desc" });
    expect(parseFolderSort("duration", "sideways")).toEqual({ key: "duration", dir: "desc" });
    expect(parseFolderSort("rubbish", "asc")).toEqual({ key: "name", dir: "asc" });
  });
  it("orders by name, duration or artist, either way, with ties in name order", async () => {
    const w = await album();
    expect(await names(w, ["name", "asc"])).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);
    expect(await names(w, ["name", "desc"])).toEqual(["Gamma", "Delta", "Beta", "Alpha"]);
    expect(await names(w, ["duration", "asc"])).toEqual(["Alpha", "Delta", "Beta", "Gamma"]);
    expect(await names(w, ["duration", "desc"])).toEqual(["Gamma", "Beta", "Delta", "Alpha"]);
    expect(await names(w, ["artist", "asc"])).toEqual(["Beta", "Alpha", "Delta", "Gamma"]); // no artist first, then Mia, then Zed (Delta before Gamma)
    expect(await names(w, ["artist", "desc"])).toEqual(["Gamma", "Delta", "Alpha", "Beta"]);
  });
  it("pages through every sort without skipping or repeating a file", async () => {
    const w = await world();
    for (let i = 0; i < 25; i++) await w.add(`Song ${String(i).padStart(2, "0")}`, "Mix", { runtimeSeconds: (i % 5) * 60, authors: [`Artist ${i % 3}`], kind: "audiobook" });
    for (const sort of [parseFolderSort("name", "asc"), parseFolderSort("name", "desc"), parseFolderSort("duration", "asc"), parseFolderSort("duration", "desc"), parseFolderSort("artist", "asc"), parseFolderSort("artist", "desc")]) {
      const all = (await folderPlayableIds(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "Mix", sort }))!.ids;
      const seen: string[] = [];
      let after: { key: string; id: string } | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const page: Awaited<ReturnType<typeof listFolder>> = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "Mix", limit: 4, after, sort });
        seen.push(...page!.items.map((i) => i.id));
        after = page!.nextCursor;
        if (!after) break;
      }
      expect(seen, JSON.stringify(sort)).toEqual(all);
      expect(new Set(seen).size).toBe(25);
    }
  });
  it("gives select-all the same order as the page, and a file with no length sorts as zero", async () => {
    const w = await album();
    await w.add("Unknown length", "Mix", { runtimeSeconds: null, kind: "audiobook" });
    const sort = parseFolderSort("duration", "asc");
    const page = (await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "Mix", sort }))!.items.map((i) => i.id);
    const ids = (await folderPlayableIds(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "Mix", sort }))!.ids;
    expect(ids).toEqual(page);
    expect((await names(w, ["duration", "asc"]))?.[0]).toBe("Unknown length");
  });
});

describe("searching a library's files", () => {
  async function shelf() {
    const w = await world();
    await w.add("Midnight City", "Pop/M83", { authors: ["M83"], seriesName: "Hurry Up, We're Dreaming", kind: "audiobook" });
    await w.add("Wait", "Pop/M83", { authors: ["M83"], seriesName: "Hurry Up, We're Dreaming", kind: "audiobook" });
    await w.add("Intro", "Rock/Others", { authors: ["The Xx"], seriesName: "xx", kind: "audiobook" });
    await w.add("100% pure_fun", "", { authors: null, kind: "audiobook" });
    return w;
  }
  const search = async (w: Awaited<ReturnType<typeof world>>, text: string, path = "") =>
    (await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path, search: text }))?.items.map((i) => i.name);

  it("finds files by name, artist, album or folder across the whole library, ignoring case", async () => {
    const w = await shelf();
    expect(await search(w, "midnight")).toEqual(["Midnight City"]);
    expect((await search(w, "m83"))?.sort()).toEqual(["Midnight City", "Wait"]); // by artist (and folder)
    expect((await search(w, "hurry up"))?.sort()).toEqual(["Midnight City", "Wait"]); // by album
    expect(await search(w, "THE XX")).toEqual(["Intro"]);
    expect(await search(w, "rock/oth")).toEqual(["Intro"]); // by folder
    expect(await search(w, "nothing like this")).toEqual([]);
  });
  it("takes % and _ literally, ignores the folder it was asked from, and lists no folders", async () => {
    const w = await shelf();
    expect(await search(w, "100%")).toEqual(["100% pure_fun"]);
    expect(await search(w, "e_f")).toEqual(["100% pure_fun"]);
    expect(await search(w, "%")).toEqual(["100% pure_fun"]); // not "everything"
    expect(await search(w, "m83", "Rock")).toHaveLength(2);
    const page = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "", search: "m83" });
    expect(page?.folders).toEqual([]);
  });
  it("never finds what this profile can't see, and follows the sort and the paging", async () => {
    const w = await world();
    await w.add("Kid song", "", { authors: ["Zed"], runtimeSeconds: 10, ratingAges: { ANY: 0 }, kind: "audiobook" });
    await w.add("Adult song", "", { authors: ["Zed"], runtimeSeconds: 99, ratingAges: { ANY: 17 }, kind: "audiobook" });
    expect(await listFolder(db, { actor: w.actor(w.member), viewer: kid, libraryId: w.library.id, path: "", search: "zed" }).then((p) => p?.items.map((i) => i.name))).toEqual(["Kid song"]);
    for (let i = 0; i < 9; i++) await w.add(`Zed track ${i}`, "Zed", { authors: ["Zed"], runtimeSeconds: i * 10, kind: "audiobook" });
    const sort = parseFolderSort("duration", "asc");
    const all = (await folderPlayableIds(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "", search: "zed", sort }))!.ids;
    const seen: string[] = [];
    let after: { key: string; id: string } | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: Awaited<ReturnType<typeof listFolder>> = await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "", search: "zed", limit: 3, after, sort });
      seen.push(...page!.items.map((i) => i.id));
      after = page!.nextCursor;
      if (!after) break;
    }
    expect(seen).toEqual(all);
    expect(all).toHaveLength(11);
  });
});

describe("search text and links", () => {
  it("cleans a search from a URL", () => {
    expect(parseFolderSearch("  hello \n")).toBe("hello");
    expect(parseFolderSearch("")).toBeNull();
    expect(parseFolderSearch(undefined)).toBeNull();
    expect(parseFolderSearch("   ")).toBeNull();
    expect(parseFolderSearch("x".repeat(200))).toHaveLength(64);
  });
  it("builds a library address from what the page carries, in a fixed order, leaving out the defaults", () => {
    const base = "/s/S/library/L";
    expect(folderLink({ base })).toBe(base);
    expect(folderLink({ base, sort: parseFolderSort("name", "asc") })).toBe(base);
    expect(folderLink({ base, sort: parseFolderSort("duration", "desc"), q: "a b", path: "My Music/Rock" })).toBe(`${base}?sort=duration&dir=desc&q=a%20b&path=My%20Music%2FRock`);
    expect(folderLink({ base, extra: "view=folders&", q: "x" })).toBe(`${base}?view=folders&q=x`);
    expect(folderLink({ base, path: "A" })).toBe(`${base}?path=A`);
  });
});

describe("the whole library, and one artist, album or genre of it", () => {
  async function shelf() {
    const w = await world();
    await w.add("Midnight City", "Pop/M83", { authors: ["M83"], seriesName: "Dreaming", genres: ["Electronic", "Pop"], kind: "audiobook" });
    await w.add("Wait", "Pop/M83", { authors: ["m83 "], seriesName: "Dreaming", genres: ["Electronic"], kind: "audiobook" });
    await w.add("Intro", "Rock/Others", { authors: ["The Xx", "Guest"], seriesName: "xx", genres: ["Indie", "pop"], kind: "audiobook" });
    await w.add("Loose", "", { authors: null, genres: [], kind: "audiobook" });
    return w;
  }
  const list = async (w: Awaited<ReturnType<typeof world>>, extra: Record<string, unknown>) =>
    (await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "Somewhere/else", ...extra }))?.items.map((i) => i.name).sort();

  it("lists every file of the library, whatever folder it was asked from, with no subfolders", async () => {
    const w = await shelf();
    expect(await list(w, { all: true })).toEqual(["Intro", "Loose", "Midnight City", "Wait"]);
    expect((await listFolder(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, path: "", all: true }))?.folders).toEqual([]);
  });
  it("lists the files of one artist, album or genre, ignoring case and edge spaces, and the unknown ones", async () => {
    const w = await shelf();
    expect(await list(w, { group: { kind: "artist", name: "M83" } })).toEqual(["Midnight City", "Wait"]);
    expect(await list(w, { group: { kind: "artist", name: "the xx" } })).toEqual(["Intro"]); // the first artist only
    expect(await list(w, { group: { kind: "artist", name: UNKNOWN_GROUP } })).toEqual(["Loose"]);
    expect(await list(w, { group: { kind: "album", name: "dreaming" } })).toEqual(["Midnight City", "Wait"]);
    expect(await list(w, { group: { kind: "album", name: UNKNOWN_GROUP } })).toEqual(["Loose"]);
    expect(await list(w, { group: { kind: "genre", name: "POP" } })).toEqual(["Intro", "Midnight City"]);
    expect(await list(w, { group: { kind: "genre", name: "Electronic" } })).toEqual(["Midnight City", "Wait"]);
    expect(await list(w, { group: { kind: "genre", name: UNKNOWN_GROUP } })).toEqual(["Loose"]);
    expect(await list(w, { group: { kind: "genre", name: "Nothing" } })).toEqual([]);
    expect(await list(w, { group: { kind: "genre", name: "Pop" }, search: "city" })).toEqual(["Midnight City"]); // a search narrows a group
  });
  it("builds the lists of artists, albums and genres with counts, a page at a time, leaving out what an age limit hides", async () => {
    const w = await world();
    const lib = await makeLibrary(db, w.server.id, "audio", "everyone");
    const add = (name: string, over: Record<string, unknown>) => makeTitle(db, lib.id, { name, kind: "audiobook", boxFolderId: `file:${Math.random()}`, ...over });
    await add("Midnight City", { authors: ["M83"], seriesName: "Dreaming", genres: ["Electronic", "Pop"], ratingAges: { ANY: 0 } });
    await add("Wait", { authors: ["m83 "], seriesName: "Dreaming", genres: ["Electronic"], ratingAges: { ANY: 0 } });
    await add("Intro", { authors: ["The Xx", "Guest"], seriesName: "xx", genres: ["Indie", "pop"], ratingAges: { ANY: 0 } });
    await add("Loose", { authors: null, genres: [], ratingAges: { ANY: 0 } });
    await add("Adult", { authors: ["Hidden Artist"], genres: ["Hidden"], ratingAges: { ANY: 17 } });
    const seen = (kind: "artist" | "album" | "genre", viewer: typeof adult | typeof kid = adult) => listAudioGroups(db, { actor: w.actor(w.member), viewer, libraryId: lib.id, kind });
    expect((await seen("artist"))?.items.map((g) => [g.label, g.count])).toEqual([["Hidden Artist", 1], ["M83", 2], ["The Xx", 1], ["Unknown artist", 1]]);
    expect((await seen("artist", kid))?.items.map((g) => g.label)).toEqual(["M83", "The Xx", "Unknown artist"]); // the adult song is hidden from this kid
    expect((await seen("genre"))?.items.map((g) => [g.label, g.count])).toEqual([["Electronic", 2], ["Hidden", 1], ["Indie", 1], ["Pop", 2], ["Unknown genre", 1]]);
    const first = await listAudioGroups(db, { actor: w.actor(w.member), viewer: adult, libraryId: lib.id, kind: "album", limit: 1 });
    expect(first?.items.map((g) => g.label)).toEqual(["Dreaming"]);
    const second = await listAudioGroups(db, { actor: w.actor(w.member), viewer: adult, libraryId: lib.id, kind: "album", limit: 1, after: first?.next });
    expect(second?.items.map((g) => g.label)).toEqual(["xx"]);
  });
  it("is null for a library that isn't audio or music, or isn't visible", async () => {
    const w = await world("restricted");
    expect(await listAudioGroups(db, { actor: w.actor(w.member), viewer: adult, libraryId: w.library.id, kind: "artist" })).toBeNull();
    const open = await world();
    expect(await listAudioGroups(db, { actor: open.actor(open.member), viewer: adult, libraryId: open.library.id, kind: "artist" })).toBeNull(); // a video library
  });
});
