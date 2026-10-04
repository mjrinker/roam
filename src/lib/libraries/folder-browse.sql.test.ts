/** Folder browsing for video libraries: path rules, nesting, hiding, and paging on a real in-memory Postgres. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { folderTrail, listFolder, normalizeFolderPath, parentFolder } from "./folder-browse";
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

  it("pages videos by name with a cursor, listing folders only on the first page", async () => {
    const w = await world();
    for (const name of ["v1", "v2", "v3", "v4", "v5"]) await w.add(name, "");
    await w.add("x", "Sub");
    const seen: string[] = [];
    let after: { name: string; id: string } | null = null;
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
