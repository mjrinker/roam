/** The admin's photo edits as a file: exported, the faces searched for again, imported back. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { mediaFiles, photoFaces, photoPeople, titles } from "@/lib/db/schema";
import { createTestDb, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { changeFace } from "@/lib/faces/service";
import { normalize, toBytes } from "@/lib/faces/geometry";
import { applyPhotoEdits, buildPhotoEditsExport, exportPhotoEdits, overlap, parsePhotoEdits } from "./photo-edits";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

const print = (i: number, wobble = 0) => {
  const v = new Array(8).fill(0);
  v[i] = 1;
  v[7] = wobble;
  return normalize(v);
};
let n = 0;
async function world() {
  const owner = await makeAccount(db, "o");
  const server = await makeServer(db, owner.accountId);
  const library = await makeLibrary(db, server.id, "photos", "everyone");
  const photo = async (filename: string, folder = "2019/Beach") => {
    const t = await makeTitle(db, library.id, { kind: "photo", boxFolderId: `file:pe${++n}`, folderPath: folder, takenAt: new Date("2026-10-18T10:00:00Z"), takenAtSource: "box" });
    await db.insert(mediaFiles).values({ ownerKind: "title", ownerId: t.id, partIndex: 0, boxFileId: `bx${n}`, filename, sizeBytes: 10, container: "jpg", probeStatus: "ok" });
    return t;
  };
  const face = async (titleId: string, embedding: Float32Array, box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }) =>
    (await db.insert(photoFaces).values({ titleId, ...box, score: 0.9, embedding: toBytes(embedding), thumb: Buffer.from([1]) }).returning())[0];
  return { server, library, photo, face };
}

describe("photo edits export and import", () => {
  it("brings tags back onto faces found again, even at a slightly different size, and the dates and places set by hand", async () => {
    const w = await world();
    const a = await w.photo("IMG_1.JPG");
    const b = await w.photo("IMG_2.JPG", "2020");
    const c = await w.photo("IMG_3.JPG");
    const fa = await w.face(a.id, print(0));
    const fb = await w.face(b.id, print(0, 0.1));
    const fc = await w.face(c.id, print(1));
    await changeFace(db, w.server.id, fa.id, { newPerson: "Ann Lee" });
    await changeFace(db, w.server.id, fb.id, { person: (await db.select().from(photoPeople).where(eq(photoPeople.serverId, w.server.id)))[0].id });
    await changeFace(db, w.server.id, fc.id, { ignore: true });
    await db.update(titles).set({ takenAt: new Date("2015-06-01T08:30:00Z"), takenAtSource: "manual" }).where(eq(titles.id, a.id));
    await db.update(titles).set({ latitude: 37.7749, longitude: -122.4194, placeName: "San Francisco", placeSource: "manual" }).where(eq(titles.id, a.id));
    await db.update(titles).set({ latitude: null, longitude: null, placeSource: "manual" }).where(eq(titles.id, b.id));

    const file = buildPhotoEditsExport(await exportPhotoEdits(db, w.server.id), { serverName: "S", now: new Date("2026-10-19T00:00:00Z") });
    const parsed = parsePhotoEdits(file);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.edits.people).toEqual(["Ann Lee"]);
    expect(parsed.edits.tags).toHaveLength(2);
    expect(parsed.edits.dismissed).toHaveLength(1);
    expect(parsed.edits.dates).toEqual([{ photo: { library: expect.any(String), folder: "2019/Beach", filename: "IMG_1.JPG" }, takenAt: "2015-06-01T08:30:00.000Z" }]);
    expect(parsed.edits.places.map((p) => p.latitude)).toEqual(expect.arrayContaining([37.7749, null]));

    // Everything done by hand is lost (the faces are searched for again, the dates and places reset), as after a rebuild.
    await db.delete(photoFaces).where(eq(photoFaces.titleId, a.id));
    await db.delete(photoFaces).where(eq(photoFaces.titleId, b.id));
    await db.delete(photoFaces).where(eq(photoFaces.titleId, c.id));
    await db.delete(photoPeople).where(eq(photoPeople.serverId, w.server.id));
    await db.update(titles).set({ takenAt: new Date("2026-10-18T10:00:00Z"), takenAtSource: "box", latitude: null, longitude: null, placeName: null, placeSource: null }).where(eq(titles.libraryId, w.library.id));
    const again = await w.face(a.id, print(0), { x: 0.11, y: 0.09, w: 0.21, h: 0.2 }); // found again, a little different
    await w.face(b.id, print(0, 0.1), { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    await w.face(c.id, print(1), { x: 0.1, y: 0.1, w: 0.2, h: 0.2 });

    const result = await applyPhotoEdits(db, w.server.id, parsed.edits);
    expect(result).toMatchObject({ tags: 2, dismissed: 1, dates: 1, places: 2, people: 1, waitingForFaces: 0, notFound: { total: 0 } });
    const [ann] = await db.select().from(photoPeople).where(eq(photoPeople.serverId, w.server.id));
    expect(ann.name).toBe("Ann Lee");
    expect((await db.select().from(photoFaces).where(eq(photoFaces.id, again.id)))[0].personId).toBe(ann.id);
    const [ta] = await db.select().from(titles).where(eq(titles.id, a.id));
    expect([ta.takenAt?.toISOString(), ta.takenAtSource, ta.latitude, ta.placeName, ta.placeSource]).toEqual(["2015-06-01T08:30:00.000Z", "manual", 37.7749, "San Francisco", "manual"]);
    const [tb] = await db.select().from(titles).where(eq(titles.id, b.id));
    expect([tb.latitude, tb.placeSource]).toEqual([null, "manual"]);
    expect((await db.select().from(photoFaces).where(and(eq(photoFaces.titleId, c.id), eq(photoFaces.ignored, true)))).length).toBe(1);
  });

  it("waits for faces that aren't found yet, names pictures that aren't here, and adds without removing", async () => {
    const w = await world();
    const a = await w.photo("IMG_1.JPG");
    const library = (await db.select({ name: (await import("@/lib/db/schema")).libraries.name }).from((await import("@/lib/db/schema")).libraries).where(eq((await import("@/lib/db/schema")).libraries.id, w.library.id)))[0].name;
    const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    const edits = {
      people: ["Zed"],
      tags: [{ photo: { library, folder: "2019/Beach", filename: "IMG_1.JPG" }, box, person: "Ann" }],
      dismissed: [],
      dates: [{ photo: { library, folder: "", filename: "gone.jpg" }, takenAt: "2010-01-01T00:00:00.000Z" }],
      places: [],
    };
    const r = await applyPhotoEdits(db, w.server.id, edits);
    expect(r).toMatchObject({ tags: 0, waitingForFaces: 1, people: 1, notFound: { total: 1, sample: ["gone.jpg"] } });
    // Later, once the face exists, the same file puts the tag on it; the existing person is reused, not doubled.
    const f = await w.face(a.id, print(0));
    const second = await applyPhotoEdits(db, w.server.id, edits);
    expect(second).toMatchObject({ tags: 1, waitingForFaces: 0, people: 1 }); // Ann is new; Zed is reused
    expect((await db.select().from(photoFaces).where(eq(photoFaces.id, f.id)))[0].personId).not.toBeNull();
    expect(await db.select().from(photoPeople).where(eq(photoPeople.serverId, w.server.id))).toHaveLength(2);
  });

  it("only touches this server's pictures, and refuses other files", async () => {
    const mine = await world();
    const theirs = await world();
    await theirs.photo("IMG_1.JPG");
    const [lib] = await db.select().from((await import("@/lib/db/schema")).libraries).where(eq((await import("@/lib/db/schema")).libraries.id, theirs.library.id));
    const r = await applyPhotoEdits(db, mine.server.id, { people: [], tags: [], dismissed: [], dates: [{ photo: { library: lib.name, folder: "2019/Beach", filename: "IMG_1.JPG" }, takenAt: "2001-01-01T00:00:00.000Z" }], places: [] });
    expect(r.dates).toBe(0);
    expect(r.notFound.total).toBe(1);
    expect(parsePhotoEdits("nope").ok).toBe(false);
    expect(parsePhotoEdits('{"format":"roam-profile"}').ok).toBe(false);
  });
});

describe("overlap", () => {
  it("is 1 for the same box, 0 for apart, and high for the same face a little shifted", () => {
    const a = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    expect(overlap(a, a)).toBeCloseTo(1, 6);
    expect(overlap(a, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 })).toBe(0);
    expect(overlap(a, { x: 0.11, y: 0.09, w: 0.21, h: 0.2 })).toBeGreaterThan(0.7);
  });
});
