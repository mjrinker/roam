/** The playlist API through a device token: which playlists, which items, and what stays hidden. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, makePlaylist, addItem, type TestDb } from "@/lib/playlists/test-db";
import { createDeviceToken, setTokenProfile } from "@/lib/auth/device-token";
import { GET as lists } from "./servers/[serverId]/playlists/route";
import { GET as one } from "./servers/[serverId]/playlists/[playlistId]/route";

let db: TestDb;
beforeAll(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  await import("@/lib/db/client");
  db = h.testDb.db;
});
beforeEach(() => {
  h.headers = {};
});

const req = (path = "/x") => new Request(`https://roam.example${path}`);
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const as = async (who: Awaited<ReturnType<typeof makeAccount>>) => {
  const { token, row } = await createDeviceToken(db, { accountId: who.accountId, label: "Test" });
  if (!row.viewerId) await setTokenProfile(db, row.id, who.viewer);
  h.headers = { authorization: `Bearer ${token}` };
};

let n = 0;
async function world() {
  const admin = await makeAccount(db, `padmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const member = await makeAccount(db, `pmember${++n}`);
  await joinServer(db, server.id, member.accountId);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "The Film", year: 2001 });
  const photo = await makeTitle(db, movies.id, { kind: "photo", name: "Snap" });
  const { show, episodes } = await makeShow(db, shows.id, 2, { name: "The Show" });
  const list = await makePlaylist(db, { serverId: server.id, ownerViewerId: member.viewer.id, name: "Friday" });
  await addItem(db, list.id, { titleId: film.id }, 1024);
  await addItem(db, list.id, { episodeId: episodes[0].id }, 2048);
  await addItem(db, list.id, { titleId: photo.id }, 3072);
  await as(member);
  return { server, member, film, show, episodes, list, sid: { serverId: server.id } };
}

describe("playlists", () => {
  it("lists the profile's playlists", async () => {
    const w = await world();
    const body = await json(await lists(req(), ctx(w.sid)));
    expect(body.playlists).toEqual([expect.objectContaining({ id: w.list.id, name: "Friday", itemCount: 2, canAdd: true })]);
  });
  it("opens one, with movies and episodes as items and photos left out", async () => {
    const w = await world();
    const body = await json(await one(req(), ctx({ ...w.sid, playlistId: w.list.id })));
    expect(body.playlist.name).toBe("Friday");
    expect(body.items.map((i: { type: string; id: string }) => [i.type, i.id])).toEqual([["movie", w.film.id], ["episode", w.episodes[0].id]]);
    expect(body.items[1].subtitle).toContain("E1");
    expect(body.items[0].entryId).toBeTruthy();
    expect(body.next).toBeNull();
  });
  it("is not there for another profile's private playlist, another server, a bad id or a bad cursor, or without a token", async () => {
    const w = await world();
    const other = await world();
    expect((await one(req(), ctx({ ...w.sid, playlistId: other.list.id }))).status).toBe(404);
    await as(w.member);
    expect((await one(req(), ctx({ ...w.sid, playlistId: "nope" }))).status).toBe(404);
    expect((await one(req("/x?after=junk"), ctx({ ...w.sid, playlistId: w.list.id }))).status).toBe(404);
    h.headers = {};
    expect((await lists(req(), ctx(w.sid))).status).toBe(401);
    expect((await one(req(), ctx({ ...w.sid, playlistId: w.list.id }))).status).toBe(401);
  });
});
