/**
 * Faces in photos over HTTP: anyone who can see a picture sees who is named in it; only the server's admin names faces, confirms suggestions
 * or edits people; a face's picture follows its photo's access.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));

import { photoFaces, photoPeople, profiles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { normalize, toBytes } from "@/lib/faces/geometry";
import { GET as FACES } from "../photos/[id]/faces/route";
import { PUT as CHANGE } from "./[faceId]/route";
import { GET as THUMB } from "./[faceId]/thumb/route";
import { DELETE as REMOVE_PERSON, PATCH as RENAME_PERSON } from "../people/[personId]/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

const print = (i: number, wobble = 0) => {
  const v = new Array(8).fill(0);
  v[i] = 1;
  v[7] = wobble;
  return normalize(v);
};
const ctxOf = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const json = (method: string, body: unknown) => new Request("http://x", { method, body: JSON.stringify(body) });
async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}
let n = 0;
async function world() {
  const owner = await makeAccount(db, "owner");
  const server = await makeServer(db, owner.accountId);
  const member = await makeAccount(db, "member");
  await joinServer(db, server.id, member.accountId);
  const photos = await makeLibrary(db, server.id, "photos", "everyone");
  const secret = await makeLibrary(db, server.id, "photos", "restricted");
  const mk = async (libraryId: string, wobble: number) => {
    const t = await makeTitle(db, libraryId, { kind: "photo", boxFolderId: `file:fc${++n}` });
    const [face] = await db.insert(photoFaces).values({ titleId: t.id, x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 0.9, embedding: toBytes(print(0, wobble)), thumb: Buffer.from([0xff, 0xd8, 1, 2]) }).returning();
    return { t, face };
  };
  return { owner, member, server, photos, one: await mk(photos.id, 0), two: await mk(photos.id, 0.1), hidden: await mk(secret.id, 0) };
}
const facesOf = async (id: string) => FACES(new Request("http://x"), ctxOf({ id }));
const change = (faceId: string, body: unknown) => CHANGE(json("PUT", body), ctxOf({ faceId }));

describe("faces in photos", () => {
  it("the admin names a face and sees a suggestion on the alike one; a member sees names only", async () => {
    const w = await world();
    await signInAs(w.owner.accountId);
    const named = await change(w.one.face.id, { newPerson: "Ann Lee" });
    expect(named.status).toBe(200);
    const admin = await (await facesOf(w.two.t.id)).json();
    expect(admin.canEdit).toBe(true);
    expect(admin.people).toEqual([expect.objectContaining({ name: "Ann Lee" })]);
    expect(admin.faces[0].suggestion).toMatchObject({ name: "Ann Lee" });

    expect((await change(w.two.face.id, { confirm: true })).status).toBe(200);
    await signInAs(w.member.accountId);
    const seen = await (await facesOf(w.two.t.id)).json();
    expect(seen.canEdit).toBe(false);
    expect(seen.people).toBeUndefined();
    expect(seen.faces[0].person).toMatchObject({ name: "Ann Lee" });
  });

  it("only the admin may change a face or a person: anyone else gets a plain not-found and nothing changes", async () => {
    const w = await world();
    await signInAs(w.owner.accountId);
    await change(w.one.face.id, { newPerson: "Ann" });
    const [ann] = await db.select().from(photoPeople).where(eq(photoPeople.serverId, w.server.id));
    await signInAs(w.member.accountId);
    expect((await change(w.two.face.id, { newPerson: "Mallory" })).status).toBe(404);
    expect((await RENAME_PERSON(json("PATCH", { name: "Zed" }), ctxOf({ personId: ann.id }))).status).toBe(404);
    expect((await REMOVE_PERSON(new Request("http://x", { method: "DELETE" }), ctxOf({ personId: ann.id }))).status).toBe(404);
    expect((await db.select().from(photoPeople).where(eq(photoPeople.serverId, w.server.id))).map((p) => p.name)).toEqual(["Ann"]);
  });

  it("refuses nonsense and decisions that don't apply", async () => {
    const w = await world();
    await signInAs(w.owner.accountId);
    for (const body of [{}, { person: "nope" }, { newPerson: "" }, { confirm: false }, { newPerson: "A", ignore: true }, "x"]) {
      expect((await change(w.one.face.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await change(w.one.face.id, { confirm: true })).status).toBe(409); // nothing was suggested
    expect((await change("00000000-0000-4000-8000-0000000000bb", { ignore: true })).status).toBe(404);
  });

  it("the admin renames, merges and removes people, and dismisses a face", async () => {
    const w = await world();
    await signInAs(w.owner.accountId);
    await change(w.one.face.id, { newPerson: "Ann" });
    await change(w.two.face.id, { newPerson: "Anna" });
    const people = await db.select().from(photoPeople).where(eq(photoPeople.serverId, w.server.id));
    const anna = people.find((p) => p.name === "Anna")!;
    expect((await RENAME_PERSON(json("PATCH", { name: "ann" }), ctxOf({ personId: anna.id }))).status).toBe(200);
    const left = await db.select().from(photoPeople).where(eq(photoPeople.serverId, w.server.id));
    expect(left).toHaveLength(1);
    const [ann] = left;
    expect((await REMOVE_PERSON(new Request("http://x", { method: "DELETE" }), ctxOf({ personId: ann.id }))).status).toBe(200);
    expect((await db.select().from(photoFaces).where(eq(photoFaces.id, w.one.face.id)))[0].personId).toBeNull();
    expect((await change(w.one.face.id, { ignore: true })).status).toBe(200);
    expect((await (await facesOf(w.one.t.id)).json()).faces).toEqual([]);
  });

  it("a face's picture, and the list, follow the photo's access: a hidden library's are not found", async () => {
    const w = await world();
    await signInAs(w.member.accountId);
    const ok = await THUMB(new Request("http://x"), ctxOf({ faceId: w.one.face.id }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect(ok.headers.get("cache-control")).toContain("private");
    expect(Array.from(new Uint8Array(await ok.arrayBuffer()))).toEqual([0xff, 0xd8, 1, 2]);
    expect((await THUMB(new Request("http://x"), ctxOf({ faceId: w.hidden.face.id }))).status).toBe(404);
    expect((await facesOf(w.hidden.t.id)).status).toBe(404);
    expect((await THUMB(new Request("http://x"), ctxOf({ faceId: "not-a-uuid" }))).status).toBe(404);
  });
});
