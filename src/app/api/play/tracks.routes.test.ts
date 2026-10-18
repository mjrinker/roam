/** The audio and subtitle tracks inside a video file: listed, cut as playable pieces, and read as cues, for those who may play it. */
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  headers: {} as Record<string, string>,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(h.headers),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
vi.mock("@/lib/storage/server-storage", () => ({
  createStorageForServer: () => ({ getStreamingUrl: async () => ({ url: "https://storage.example/file.mp4", expiresAt: new Date(Date.now() + 60_000) }) }),
}));

import { eq } from "drizzle-orm";
import { mediaFiles } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeTitle, type TestDb, autoFiles } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { GET as list } from "./[ownerKind]/[ownerId]/tracks/[fileId]/route";
import { GET as piece } from "./[ownerKind]/[ownerId]/tracks/[fileId]/audio/[track]/[piece]/route";
import { GET as text } from "./[ownerKind]/[ownerId]/tracks/[fileId]/text/[track]/route";

autoFiles();
const fixture = readFileSync("src/lib/media-tracks/fixtures/multi.mp4");
const realFetch = globalThis.fetch;

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
  // The storage service answers range requests from the fixture file.
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const m = /bytes=(\d+)-(\d+)/.exec(String((init?.headers as Record<string, string>)?.Range));
    const a = Number(m![1]);
    const b = Math.min(Number(m![2]), fixture.length - 1);
    const body = fixture.subarray(a, b + 1);
    return new Response(new Uint8Array(body), { status: 206, headers: { "content-length": String(body.length) } });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  h.headers = {};
});

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const req = () => new Request("https://roam.example/x");
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};

let n = 0;
async function world() {
  const admin = await makeAccount(db, `tadmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, `tme${++n}`);
  await joinServer(db, server.id, me.accountId);
  const outsider = await makeAccount(db, `tout${++n}`);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "Film" });
  const other = await makeTitle(db, movies.id, { kind: "movie", name: "Other" });
  const fileOf = async (titleId: string) => {
    const [row] = await db.select().from(mediaFiles).where(eq(mediaFiles.ownerId, titleId));
    await db.update(mediaFiles).set({ sizeBytes: fixture.length }).where(eq(mediaFiles.id, row.id));
    return row.id;
  };
  return { me, outsider, film, other, file: await fileOf(film.id), otherFile: await fileOf(other.id), movies };
}
const p = (w: { film: { id: string }; file: string }, rest: Record<string, string> = {}) => ({ ownerKind: "title", ownerId: w.film.id, fileId: w.file, ...rest });

describe("the tracks inside a file", () => {
  it("lists its audio and subtitle tracks for someone who may play it", async () => {
    const w = await world();
    await as(w.me);
    const res = await list(req(), ctx(p(w)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audioTracks.map((a: { language: string; label: string }) => [a.language, a.label])).toEqual([["eng", "English 5.1"], ["spa", "Spanish Stereo"], ["por", "Portuguese Stereo"]]);
    expect(body.textTracks.map((t: { language: string }) => t.language)).toEqual(["eng", "spa"]);
  });

  it("cuts an audio track into an init piece and numbered pieces, and says when there are no more", async () => {
    const w = await world();
    await as(w.me);
    const init = await piece(req(), ctx(p(w, { track: "1", piece: "init" })));
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toBe("audio/mp4");
    expect(Buffer.from(await init.arrayBuffer()).subarray(4, 8).toString()).toBe("ftyp");
    const first = await piece(req(), ctx(p(w, { track: "1", piece: "0" })));
    expect(Buffer.from(await first.arrayBuffer()).subarray(4, 8).toString()).toBe("moof");
    expect((await piece(req(), ctx(p(w, { track: "1", piece: "5" })))).status).toBe(204);
    expect((await piece(req(), ctx(p(w, { track: "9", piece: "0" })))).status).toBe(404);
    expect((await piece(req(), ctx(p(w, { track: "1", piece: "abc" })))).status).toBe(404);
  });

  it("reads a subtitle track as cues", async () => {
    const w = await world();
    await as(w.me);
    const res = await text(req(), ctx(p(w, { track: "1" })));
    const { cues } = await res.json();
    expect(cues[0]).toEqual([1, 3.5, "Hola."]);
    expect((await text(req(), ctx(p(w, { track: "7" })))).status).toBe(404);
  });

  it("works for the browser-friendly copy of a file, not for another title's file or a stranger", async () => {
    const w = await world();
    await as(w.me);
    const [primary] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, w.file));
    const [copy] = await db.insert(mediaFiles).values({ ...primary, id: undefined, ownerKind: null, ownerId: null, partIndex: 0, boxFileId: "copy-1", variantOfMediaFileId: primary.id, sizeBytes: fixture.length } as never).returning();
    expect((await list(req(), ctx(p(w, { fileId: copy.id })))).status).toBe(200);
    expect((await list(req(), ctx(p(w, { fileId: w.otherFile })))).status).toBe(404);
    expect((await list(req(), ctx(p(w, { fileId: "not-a-uuid" })))).status).toBe(404);
    await as(w.outsider);
    expect([403, 404]).toContain((await list(req(), ctx(p(w)))).status);
    expect([403, 404]).toContain((await piece(req(), ctx(p(w, { track: "0", piece: "init" })))).status);
  });
});
