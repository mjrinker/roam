/** Subtitles kept with a title: the admin saves them, anyone who can play it reads them. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb }, resolution: null as unknown }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("@/lib/auth/viewer", () => ({ getCurrentViewer: async () => h.resolution }));
vi.mock("@/lib/storage/server-storage", () => ({
  createStorageForServer: () => ({
    fetchByteRange: async () => new TextEncoder().encode("1\n00:00:01,000 --> 00:00:03,000\nHola\n").buffer,
  }),
}));

import { profiles, subtitleTracks, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb } from "@/lib/playlists/test-db";
import { POST } from "./tracks/route";
import { DELETE, GET } from "./tracks/[trackId]/route";

let db: TestDb;
beforeAll(() => {
  db = h.testDb.db;
});
async function signInAs(accountId: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, accountId));
  h.resolution = { account, viewer: all[0], viewers: all };
}
const ctx = (trackId: string) => ({ params: Promise.resolve({ trackId }) }) as never;
const post = (body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const get = (id: string) => GET(new Request("http://x"), ctx(id));
const del = (id: string) => DELETE(new Request("http://x", { method: "DELETE" }), ctx(id));

async function world() {
  const admin = await makeAccount(db, "kadmin");
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, "kmember");
  await joinServer(db, server.id, member.accountId);
  const outsider = await makeAccount(db, "koutsider");
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "Film" });
  return { admin, member, outsider, film };
}
const cues = [[1, 2.5, "Hello"], [3, 4, "Bye"]];

describe("keeping subtitles for everyone", () => {
  it("lets the admin save a track and any member read it, but not a member save one", async () => {
    const w = await world();
    await signInAs(w.member.accountId);
    expect((await post({ ownerKind: "title", ownerId: w.film.id, language: "en", label: "English", cues })).status).toBe(403);
    await signInAs(w.admin.accountId);
    const res = await post({ ownerKind: "title", ownerId: w.film.id, language: "en", label: "English", cues });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const [row] = await db.select().from(subtitleTracks).where(eq(subtitleTracks.id, id));
    expect(row).toMatchObject({ language: "eng", source: "saved", label: "English" });
    await signInAs(w.member.accountId);
    expect(await (await get(id)).json()).toEqual({ cues });
    await signInAs(w.outsider.accountId);
    expect((await get(id)).status).toBe(404);
  });

  it("refuses badly formed cues, an empty label and too many tracks", async () => {
    const w = await world();
    await signInAs(w.admin.accountId);
    const base = { ownerKind: "title", ownerId: w.film.id, label: "X" };
    expect((await post({ ...base, cues: [] })).status).toBe(400);
    expect((await post({ ...base, cues: [[2, 1, "backwards"]] })).status).toBe(400);
    expect((await post({ ...base, cues: [["a", 1, "x"]] })).status).toBe(400);
    expect((await post({ ...base, label: "  ", cues })).status).toBe(400);
    for (let i = 0; i < 12; i++) expect((await post({ ...base, label: `T${i}`, cues })).status).toBe(201);
    expect((await post({ ...base, label: "one too many", cues })).status).toBe(409);
  });

  it("reads a file beside the video from storage when asked, and only the admin removes a saved track", async () => {
    const w = await world();
    const [file] = await db.insert(subtitleTracks).values({ ownerKind: "title", ownerId: w.film.id, language: "spa", label: "Spanish", source: "file", storageFileId: "box-1", sizeBytes: 40 }).returning();
    await signInAs(w.member.accountId);
    expect(await (await get(file.id)).json()).toEqual({ cues: [[1, 3, "Hola"]] });
    await signInAs(w.admin.accountId);
    expect((await del(file.id)).status).toBe(409); // a file is removed by deleting the file
    const saved = await (await post({ ownerKind: "title", ownerId: w.film.id, label: "Mine", cues })).json();
    await signInAs(w.member.accountId);
    expect((await del(saved.id)).status).toBe(403);
    await signInAs(w.admin.accountId);
    expect((await del(saved.id)).status).toBe(200);
    expect((await get(saved.id)).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
  });
});
