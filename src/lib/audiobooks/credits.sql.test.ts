/** A person's page for audiobooks: what they wrote and narrated on this server, for what the viewer may see. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import "@/lib/db/client"; // loads the in-memory database mocked above
import { libraries } from "@/lib/db/schema";
import { loadContributor } from "./credits";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const adult = { locale: "en-US", maxAge: null, allowUnrated: true };
const kid = { locale: "en-US", maxAge: 7, allowUnrated: false };

async function world() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const me = await makeAccount(db, "me");
  await joinServer(db, server.id, me.accountId);
  const lib = await makeLibrary(db, server.id, "audiobooks", "everyone");
  const actor = { serverId: server.id, accountId: me.accountId, isAdmin: false };
  const book = (name: string, over: Record<string, unknown> = {}, libraryId = lib.id) => makeTitle(db, libraryId, { kind: "audiobook", name, ratingAges: { ANY: 0 }, ...over });
  return { server, lib, actor, book };
}

describe("an author or narrator's page", () => {
  it("lists what they wrote and what they narrated, in series order, however the name is spelled", async () => {
    const w = await world();
    await w.book("Book Two", { authors: ["Ann Author"], seriesName: "The Series", seriesPosition: "2", narrators: ["Nick Narrator"] });
    await w.book("Book One", { authors: ["ANN  author"], seriesName: "The Series", seriesPosition: "1" });
    await w.book("Narrated Only", { authors: ["Someone Else"], narrators: ["Ann Author", "Nick Narrator"] });
    await w.book("Folder Book", { authors: null, folderAuthor: "ann author" });
    await w.book("Not Hers", { authors: ["Other"] });
    const ann = await loadContributor(db, w.actor, adult, "Ann Author");
    expect(ann!.written.map((b) => b.name)).toEqual(["Book One", "Book Two", "Folder Book"]);
    expect(ann!.narrated.map((b) => b.name)).toEqual(["Narrated Only"]);
    expect(ann!.name).toBe("Ann Author");
    const nick = await loadContributor(db, w.actor, adult, "  nick narrator ");
    expect([nick!.written.length, nick!.narrated.map((b) => b.name).sort()]).toEqual([0, ["Book Two", "Narrated Only"]]);
    expect(await loadContributor(db, w.actor, adult, "Nobody At All")).toBeNull();
    expect(await loadContributor(db, w.actor, adult, "   ")).toBeNull();
  });
  it("does not use the folder author when the book names its authors", async () => {
    const w = await world();
    await w.book("Matched", { authors: ["Real Author"], folderAuthor: "Folder Name" });
    expect(await loadContributor(db, w.actor, adult, "Folder Name")).toBeNull();
  });
  it("leaves out what the viewer can't see: age limit, restricted libraries, other servers, and other kinds of title", async () => {
    const w = await world();
    const restricted = await makeLibrary(db, w.server.id, "audiobooks", "restricted");
    const music = await makeLibrary(db, w.server.id, "music", "everyone");
    await w.book("Open", { authors: ["Pat"] });
    await w.book("Adults Only", { authors: ["Pat"], ratingAges: { ANY: 17 } });
    await w.book("Hidden", { authors: ["Pat"] }, restricted.id);
    await w.book("A Song", { authors: ["Pat"] }, music.id);
    const w2 = await world();
    await w2.book("Elsewhere", { authors: ["Pat"] });
    expect((await loadContributor(db, w.actor, adult, "Pat"))!.written.map((b) => b.name).sort()).toEqual(["Adults Only", "Open"]);
    expect((await loadContributor(db, w.actor, kid, "Pat"))!.written.map((b) => b.name)).toEqual(["Open"]);
    expect((await loadContributor(db, { ...w.actor, isAdmin: true }, adult, "Pat"))!.written.map((b) => b.name).sort()).toEqual(["Adults Only", "Hidden", "Open"]);
    await db.update(libraries).set({ access: "restricted" }).where(eq(libraries.id, w.lib.id));
    expect(await loadContributor(db, w.actor, adult, "Pat")).toBeNull();
  });
});
