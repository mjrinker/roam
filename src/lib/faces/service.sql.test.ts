import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { db as clientDb } from "@/lib/db/client";
import { photoFaces, photoPeople } from "@/lib/db/schema";
import { makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { listTimeline } from "@/lib/photos/timeline";
import { parseSearch } from "@/lib/photos/search";
import { titles } from "@/lib/db/schema";
import { normalize, toBytes } from "./geometry";
import { bestMatches, changeFace, deletePerson, facesOfPhoto, peopleInLibrary, peopleOfServer, refreshSuggestions, renamePerson } from "./service";

let db: TestDb;
beforeAll(() => {
  db = clientDb as unknown as TestDb;
});

/** A fingerprint near one of a few directions: person 0, 1, 2 are far apart, `wobble` makes two faces of one person a little different. */
const print = (person: number, wobble = 0) => {
  const v = new Array(8).fill(0);
  v[person] = 1;
  v[7] = wobble;
  return normalize(v);
};
let n = 0;
async function setup() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const library = await makeLibrary(db, server.id, "photos", "everyone");
  const photo = async () => makeTitle(db, library.id, { kind: "photo", boxFolderId: `file:f${++n}` });
  const face = async (titleId: string, embedding: Float32Array, x = 0.1) =>
    (await db.insert(photoFaces).values({ titleId, x, y: 0.1, w: 0.2, h: 0.2, score: 0.9, embedding: toBytes(embedding), thumb: Buffer.from([1]) }).returning())[0];
  return { server, library, photo, face };
}
const row = async (id: string) => (await db.select().from(photoFaces).where(eq(photoFaces.id, id)))[0];

describe("bestMatches", () => {
  it("suggests the closest named person at or above the limit, and nobody under it", () => {
    const out = bestMatches(
      [{ id: "a", embedding: print(0, 0.2) }, { id: "b", embedding: print(2) }],
      [{ personId: "ann", embedding: print(0) }, { personId: "bob", embedding: print(1) }]
    );
    expect(out.get("a")?.personId).toBe("ann");
    expect(out.get("a")!.score).toBeGreaterThan(0.9);
    expect(out.has("b")).toBe(false);
  });
});

describe("naming faces", () => {
  it("naming one face suggests the same person on alike faces and not on strangers, and confirming makes it a tag", async () => {
    const s = await setup();
    const [p1, p2, p3, p4] = [await s.photo(), await s.photo(), await s.photo(), await s.photo()];
    const first = await s.face(p1.id, print(0));
    const same = await s.face(p2.id, print(0, 0.15));
    const other = await s.face(p3.id, print(1));
    const again = await s.face(p4.id, print(0, 0.3));
    const named = await changeFace(db, s.server.id, first.id, { newPerson: "  Ann   Lee " });
    expect(named.ok).toBe(true);
    const [ann] = await db.select().from(photoPeople).where(eq(photoPeople.serverId, s.server.id));
    expect(ann.name).toBe("Ann Lee");
    expect((await row(first.id)).personId).toBe(ann.id);
    expect((await row(same.id)).suggestedPersonId).toBe(ann.id);
    expect((await row(again.id)).suggestedPersonId).toBe(ann.id);
    expect((await row(other.id)).suggestedPersonId).toBeNull();
    expect((await facesOfPhoto(db, p2.id))[0]).toMatchObject({ person: null, suggestion: { id: ann.id, name: "Ann Lee" } });

    await changeFace(db, s.server.id, same.id, { confirm: true });
    expect((await row(same.id)).personId).toBe(ann.id);
    expect((await facesOfPhoto(db, p2.id))[0]).toMatchObject({ person: { name: "Ann Lee" }, suggestion: null });
    // "Ann lee" is the same person, not a second one.
    await changeFace(db, s.server.id, other.id, { newPerson: "ann lee" });
    expect(await peopleOfServer(db, s.server.id)).toHaveLength(1);
  });

  it("taking a name off, or dismissing a face, takes it out of suggestions and lists", async () => {
    const s = await setup();
    const [p1, p2] = [await s.photo(), await s.photo()];
    const a = await s.face(p1.id, print(0));
    const b = await s.face(p2.id, print(0, 0.1));
    await changeFace(db, s.server.id, a.id, { newPerson: "Ann" });
    expect((await row(b.id)).suggestedPersonId).not.toBeNull();
    await changeFace(db, s.server.id, a.id, { person: null });
    expect((await row(a.id)).personId).toBeNull();
    expect((await row(b.id)).suggestedPersonId).toBeNull(); // nobody is named any more, so nothing is suggested
    await changeFace(db, s.server.id, b.id, { ignore: true });
    expect(await facesOfPhoto(db, p2.id)).toEqual([]);
    expect(await changeFace(db, s.server.id, b.id, { confirm: true })).toEqual({ ok: false });
  });

  it("only touches the server's own faces and people, and refuses empty names", async () => {
    const mine = await setup();
    const theirs = await setup();
    const face = await theirs.face((await theirs.photo()).id, print(0));
    expect(await changeFace(db, mine.server.id, face.id, { newPerson: "Ann" })).toEqual({ ok: false });
    const own = await mine.face((await mine.photo()).id, print(0));
    expect(await changeFace(db, mine.server.id, own.id, { newPerson: "   " })).toEqual({ ok: false });
    const [stranger] = await db.insert(photoPeople).values({ serverId: theirs.server.id, name: "Zed" }).returning();
    expect(await changeFace(db, mine.server.id, own.id, { person: stranger.id })).toEqual({ ok: false });
    expect(await deletePerson(db, mine.server.id, stranger.id)).toBe(false);
    expect(await renamePerson(db, mine.server.id, stranger.id, "Zoe")).toBe(false);
  });

  it("lists people of a library by how many pictures they are in, renames them, merges two with one name, and deletes them", async () => {
    const s = await setup();
    const [p1, p2, p3] = [await s.photo(), await s.photo(), await s.photo()];
    const a1 = await s.face(p1.id, print(0));
    const a2 = await s.face(p2.id, print(0, 0.05), 0.5);
    const a2b = await s.face(p2.id, print(0, 0.06), 0.7); // two faces of Ann in one picture still count one picture
    const b1 = await s.face(p3.id, print(1));
    for (const f of [a1, a2, a2b]) await changeFace(db, s.server.id, f.id, { newPerson: "Ann" });
    await changeFace(db, s.server.id, b1.id, { newPerson: "Bob" });
    const people = await peopleInLibrary(db, s.library.id);
    expect(people.map((p) => [p.name, p.photos])).toEqual([["Ann", 2], ["Bob", 1]]);
    expect(people[0].coverFaceId).toBeTruthy();

    const bob = people[1];
    expect(await renamePerson(db, s.server.id, bob.id, "Robert")).toBe(true);
    expect((await peopleOfServer(db, s.server.id)).map((p) => p.name)).toEqual(["Ann", "Robert"]);
    expect(await renamePerson(db, s.server.id, bob.id, "ann")).toBe(true); // merges into Ann
    expect((await peopleInLibrary(db, s.library.id)).map((p) => [p.name, p.photos])).toEqual([["Ann", 3]]);
    const [ann] = await peopleOfServer(db, s.server.id);
    expect(await deletePerson(db, s.server.id, ann.id)).toBe(true);
    expect((await row(a1.id)).personId).toBeNull();
    expect(await peopleInLibrary(db, s.library.id)).toEqual([]);
  });

  it("refreshing suggestions on a server with nobody named clears nothing wrongly and returns zero", async () => {
    const s = await setup();
    await s.face((await s.photo()).id, print(0));
    expect(await refreshSuggestions(db, s.server.id)).toBe(0);
  });
});

describe("searching a library finds people and places", () => {
  it("matches a tagged person's name (not a dismissed or unnamed face) and the place name, beside file names", async () => {
    const s = await setup();
    const actor = { serverId: s.server.id, accountId: s.server.ownerId, isAdmin: true };
    const [a, b, c] = [await s.photo(), await s.photo(), await s.photo()];
    const fa = await s.face(a.id, print(0));
    await s.face(b.id, print(1));
    const fc = await s.face(c.id, print(2));
    await changeFace(db, s.server.id, fa.id, { newPerson: "Kevin Rinker" });
    await changeFace(db, s.server.id, fc.id, { newPerson: "Dana" });
    await changeFace(db, s.server.id, fc.id, { ignore: true });
    await db.update(titles).set({ placeName: "Lake Tahoe, California" }).where(eq(titles.id, b.id));
    const found = async (q: string) =>
      (await listTimeline(db, { actor, viewer: { locale: "en-US", maxAge: null, allowUnrated: true }, libraryId: s.library.id, search: parseSearch(q) }))!.items.map((i) => i.id);
    expect(await found("kevin")).toEqual([a.id]);
    expect(await found("rinker")).toEqual([a.id]);
    expect(await found("dana")).toEqual([]); // dismissed
    expect(await found("tahoe")).toEqual([b.id]);
  });
});
