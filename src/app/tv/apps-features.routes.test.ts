/** Labels, the wishlist and radio on a TV. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({
  testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb },
  resolution: null as unknown,
  profile: null as unknown,
  jar: new Map<string, string>(),
  signedOut: 0,
}));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void h.jar.set(name, value),
    delete: (arg: string | { name: string }) => void h.jar.delete(typeof arg === "string" ? arg : arg.name),
  }),
}));
vi.mock("@/lib/auth/viewer", async () => {
  const { eq } = await import("drizzle-orm");
  const { viewers } = await import("@/lib/db/schema");
  return {
    getCurrentViewer: async () => h.resolution,
    listViewers: async (accountId: string) => h.testDb.db.select().from(viewers).where(eq(viewers.accountId, accountId)),
  };
});
vi.mock("@/lib/auth/guards", async () => {
  const { and, eq } = await import("drizzle-orm");
  const { serverMembers } = await import("@/lib/db/schema");
  return {
    getCurrentProfile: async () => h.profile,
    getCurrentServerMember: async (serverId: string) => {
      const account = h.profile as { id: string } | null;
      const resolved = h.resolution as { viewer: unknown } | null;
      if (!account || !resolved) return null;
      const [m] = await h.testDb.db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.profileId, account.id), eq(serverMembers.serverId, serverId))).limit(1);
      return m ? { profile: account, role: m.role, viewer: resolved.viewer } : null;
    },
    getServerMembership: async (profileId: string, serverId: string) =>
      (await h.testDb.db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.profileId, profileId), eq(serverMembers.serverId, serverId))).limit(1))[0] ?? null,
  };
});
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { signOut: async () => void h.signedOut++ } }) }));

import { libraries, musicAlbums, musicArtists, profiles, viewers } from "@/lib/db/schema";
import { joinServer, makeAccount, makeLibrary, makeServer, makeShow, makeTitle, type TestDb, autoFiles } from "@/lib/playlists/test-db";
import { createLabel, setTitleLabel, labelsForTitle } from "@/lib/labels/service";
import { addWish, listWishes } from "@/lib/wishlist/service";

autoFiles();

import { GET as titlePage } from "./s/[serverId]/title/[id]/route";
import { GET as showPage } from "./s/[serverId]/show/[id]/route";
import { GET as homePage } from "./s/[serverId]/route";
import { GET as labelsGet, POST as labelsPost } from "./s/[serverId]/labels/route";
import { GET as labelGet } from "./s/[serverId]/labels/[id]/route";
import { GET as wishesGet } from "./s/[serverId]/wishlist/route";
import { GET as wishGet } from "./s/[serverId]/wishlist/[id]/route";
import { POST as wishAct } from "./s/[serverId]/wishlist/act/route";
import { GET as radioGet } from "./s/[serverId]/artist/[id]/radio/route";
import { GET as artistPage } from "./s/[serverId]/artist/[id]/route";
import { GET as listenGet } from "./s/[serverId]/listen/[id]/route";

let db: TestDb;
beforeAll(() => { db = h.testDb.db; });
beforeEach(() => { h.resolution = null; h.profile = null; h.jar.clear(); });

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const req = (path = "/x") => new Request(`https://roam.example${path}`);
const post = (fields: Record<string, string>, headers: Record<string, string> = {}) => new Request("https://roam.example/x", { method: "POST", headers, body: new URLSearchParams(fields) });
const text = async (r: Response) => r.text();
/** The queue a listening page carries, read from its embedded settings. */
const queueOf = (html: string) => (JSON.parse(/id="listen-config">(.*?)<\/script>/s.exec(html)?.[1] ?? "{}") as { queue?: { items: { id: string }[]; index: number } | null }).queue ?? null;

async function signIn(who: Awaited<ReturnType<typeof makeAccount>>, pick?: string) {
  const [account] = await db.select().from(profiles).where(eq(profiles.id, who.accountId));
  const all = await db.select().from(viewers).where(eq(viewers.accountId, who.accountId));
  h.resolution = { account, viewer: all.find((v) => v.id === (pick ?? who.viewer.id)) ?? all[0], viewers: all };
  h.profile = account;
}

let n = 0;
async function world() {
  const admin = await makeAccount(db, `tadmin${++n}`);
  const server = await makeServer(db, admin.accountId);
  const me = await makeAccount(db, `tme${++n}`);
  const other = await makeAccount(db, `tother${++n}`);
  await joinServer(db, server.id, me.accountId);
  await joinServer(db, server.id, other.accountId);
  await signIn(me);
  const movies = await makeLibrary(db, server.id, "movies", "everyone");
  const shows = await makeLibrary(db, server.id, "shows", "everyone");
  const film = await makeTitle(db, movies.id, { kind: "movie", name: "Film" });
  const { show } = await makeShow(db, shows.id, 1, { name: "Show" });
  const scope = (accountId: string) => ({ serverId: server.id, actor: { serverId: server.id, accountId, isAdmin: false }, viewer: { locale: "en-US", maxAge: null, allowUnrated: true }, accountId });
  return { admin, server, me, other, film, show, movies, scope, sid: { serverId: server.id } };
}

describe("labels on a TV", () => {
  it("shows a movie's labels as buttons that flip, and the Labels page and a label's titles", async () => {
    const w = await world();
    const date = await createLabel(db, w.me.viewer.id, "Date night");
    if (!date.ok) throw new Error("x");
    const page = async () => text(await titlePage(req(), ctx({ ...w.sid, id: w.film.id })));
    expect(await page()).toContain("Date night: Off");
    expect(await text(await homePage(req(), ctx(w.sid)))).toContain(`/tv/s/${w.server.id}/labels`);
    expect((await labelsPost(post({ label: date.value.id, title: w.film.id, on: "1", back: `/tv/s/${w.server.id}/title/${w.film.id}` }), ctx(w.sid))).status).toBe(303);
    expect((await labelsForTitle(db, w.me.viewer.id, w.film.id))[0].has).toBe(true);
    expect(await page()).toContain("Date night: On");
    const list = await text(await labelsGet(req(), ctx(w.sid)));
    expect(list).toContain("Date night");
    expect(list).toContain("1 title");
    const one = await text(await labelGet(req(), ctx({ ...w.sid, id: date.value.id })));
    expect(one).toContain("Film");
    await labelsPost(post({ label: date.value.id, title: w.film.id, on: "0" }), ctx(w.sid));
    expect((await labelsForTitle(db, w.me.viewer.id, w.film.id))[0].has).toBe(false);
  });

  it("works on a show's page, offers no Labels button until a label exists, and keeps one profile's labels from another", async () => {
    const w = await world();
    expect(await text(await homePage(req(), ctx(w.sid)))).not.toContain("/labels");
    expect(await text(await showPage(req(), ctx({ ...w.sid, id: w.show.id })))).not.toContain("Your labels");
    const mine = await createLabel(db, w.me.viewer.id, "Binge");
    if (!mine.ok) throw new Error("x");
    expect(await text(await showPage(req(), ctx({ ...w.sid, id: w.show.id })))).toContain("Binge: Off");
    await signIn(w.other);
    expect(await text(await showPage(req(), ctx({ ...w.sid, id: w.show.id })))).not.toContain("Binge");
    expect((await labelsPost(post({ label: mine.value.id, title: w.film.id, on: "1" }), ctx(w.sid))).status).toBe(404);
    expect((await labelGet(req(), ctx({ ...w.sid, id: mine.value.id }))).status).toBe(404);
  });

  it("refuses nonsense and other sites", async () => {
    const w = await world();
    const l = await createLabel(db, w.me.viewer.id, "L");
    if (!l.ok) throw new Error("x");
    for (const fields of [{ label: "x", title: w.film.id, on: "1" }, { label: l.value.id, title: "x", on: "1" }, { label: l.value.id, title: w.film.id, on: "2" }]) expect((await labelsPost(post(fields), ctx(w.sid))).status).toBe(404);
    expect((await labelsPost(post({ label: l.value.id, title: w.film.id, on: "1" }, { origin: "https://evil.example" }), ctx(w.sid))).status).toBe(404);
    await setTitleLabel(db, w.me.viewer.id, l.value.id, w.film.id, false);
  });
});

describe("the wishlist on a TV", () => {
  it("lists what is wanted, opens a wish, and lets a profile want it too, say it will get it, and finish it", async () => {
    const w = await world();
    const made = await addWish(db, w.scope(w.other.accountId), { kind: "movie", title: "Heat", year: 1995, note: "director's cut" });
    if (!made.ok) throw new Error("x");
    expect(await text(await homePage(req(), ctx(w.sid)))).toContain(`/tv/s/${w.server.id}/wishlist`);
    const list = await text(await wishesGet(req(), ctx(w.sid)));
    expect(list).toContain("Heat");
    const wishPage = async () => text(await wishGet(req(), ctx({ ...w.sid, id: made.value.id })));
    let page = await wishPage();
    expect(page).toContain("I want this too");
    expect(page).toContain("I&#39;ll get this");
    expect(page).toContain("director&#39;s cut");
    const act = (action: string) => wishAct(post({ id: made.value.id, action, back: `/tv/s/${w.server.id}/wishlist/${made.value.id}` }), ctx(w.sid));
    expect((await act("want")).status).toBe(303);
    expect((await listWishes(db, { ...w.scope(w.me.accountId), isAdmin: false }))[0].wants).toBe(2);
    expect(await wishPage()).toContain("stop wanting it");
    await act("claim");
    page = await wishPage();
    expect(page).toContain("We got it");
    expect(page).toContain("Not me after all");
    await act("got");
    expect((await listWishes(db, { ...w.scope(w.me.accountId), isAdmin: false }))[0].status).toBe("got");
    expect(await text(await wishesGet(req(), ctx(w.sid)))).not.toContain("Heat"); // got: no longer on the list of what is wanted
  });

  it("lets only the asker or the admin take it off, and refuses a child's profile, nonsense and other sites", async () => {
    const w = await world();
    const made = await addWish(db, w.scope(w.other.accountId), { kind: "show", title: "Severance" });
    if (!made.ok) throw new Error("x");
    const act = (action: string, headers: Record<string, string> = {}) => wishAct(post({ id: made.value.id, action, back: "/tv" }, headers), ctx(w.sid));
    expect(await text(await wishGet(req(), ctx({ ...w.sid, id: made.value.id })))).not.toContain("Take it off");
    expect((await act("remove")).status).toBe(404);
    expect((await act("bogus")).status).toBe(404);
    expect((await act("want", { origin: "https://evil.example" })).status).toBe(404);
    const [kid] = await db.insert(viewers).values({ accountId: w.me.accountId, name: "Kid", role: "limited", sortOrder: 9 }).returning();
    await signIn(w.me, kid.id);
    const asKid = await wishAct(post({ id: made.value.id, action: "want", back: "/tv" }), ctx(w.sid));
    expect(asKid.status).toBe(404);
    expect(await text(await wishGet(req(), ctx({ ...w.sid, id: made.value.id })))).not.toContain("I want this too");
    await signIn(w.other);
    expect(await text(await wishGet(req(), ctx({ ...w.sid, id: made.value.id })))).toContain("Take it off");
    expect((await act("remove")).status).toBe(303);
    expect((await wishGet(req(), ctx({ ...w.sid, id: made.value.id }))).status).toBe(404);
  });
});

describe("radio on a TV", () => {
  async function music() {
    const w = await world();
    const lib = await makeLibrary(db, w.server.id, "music", "everyone");
    await db.update(libraries).set({ musicLookup: false }).where(eq(libraries.id, lib.id)); // no outside lookups: the rest of the library fills the radio
    const artist = async (name: string) => {
      const [a] = await db.insert(musicArtists).values({ libraryId: lib.id, name, nameKey: `${name}${n}`.toLowerCase(), sortKey: name.toLowerCase() }).returning();
      const [al] = await db.insert(musicAlbums).values({ libraryId: lib.id, artistId: a.id, name: `${name} album`, nameKey: `${a.id}x` }).returning();
      const songs: string[] = [];
      for (let i = 0; i < 4; i++) songs.push((await makeTitle(db, lib.id, { kind: "audiobook", name: `${name} song ${i}`, albumId: al.id, trackNumber: i + 1 })).id);
      return { ...a, songs };
    };
    return { ...w, a: await artist("Alpha"), b: await artist("Beta"), c: await artist("Gamma") };
  }

  it("starts from the artist's page, goes to a song with the radio in the address, and queues songs of the others too", async () => {
    const w = await music();
    expect(await text(await artistPage(req(), ctx({ ...w.sid, id: w.a.id })))).toContain(`/artist/${w.a.id}/radio`);
    const res = await radioGet(req(), ctx({ ...w.sid, id: w.a.id }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "", "https://roam.example");
    expect(location.pathname).toMatch(/\/listen\/[0-9a-f-]+$/);
    expect(location.searchParams.get("radio")).toBe(w.a.id);
    const seed = location.searchParams.get("rseed");
    expect(seed).toMatch(/^\d+$/);
    const first = location.pathname.split("/").pop() as string;
    const html = await text(await listenGet(req(`${location.pathname}${location.search}`), ctx({ ...w.sid, id: first })));
    const queued = queueOf(html);
    expect(queued?.items.length).toBe(12);
    const owners = new Set(queued?.items.map((i) => [w.a, w.b, w.c].find((x) => x.songs.includes(i.id))?.name));
    expect(owners).toEqual(new Set(["Alpha", "Beta", "Gamma"]));
    expect(queued?.items[queued.index].id).toBe(first);
    expect(html).toContain(`radio=${w.a.id}`); // the next song's page keeps the radio
  });

  it("gives the same radio for the same seed, and an ordinary album queue without one", async () => {
    const w = await music();
    const load = async (id: string, qs: string) => {
      const html = await text(await listenGet(req(`/x${qs}`), ctx({ ...w.sid, id })));
      return (queueOf(html)?.items ?? []).map((i) => i.id);
    };
    const one = await load(w.a.songs[0], `?radio=${w.a.id}&rseed=12345`);
    const two = await load(w.a.songs[0], `?radio=${w.a.id}&rseed=12345`);
    const other = await load(w.a.songs[0], `?radio=${w.a.id}&rseed=777`);
    expect(two).toEqual(one);
    expect(other).not.toEqual(one);
    expect(await load(w.a.songs[0], "")).toEqual(w.a.songs); // no radio: the album
    expect(await load(w.a.songs[0], `?radio=${w.a.id}&rseed=oops`)).toEqual(w.a.songs);
  });

  it("is a not-found for an artist that isn't there, and is signed-in only", async () => {
    const w = await music();
    expect((await radioGet(req(), ctx({ ...w.sid, id: "123e4567-e89b-42d3-a456-426614174000" }))).status).toBe(404);
    expect((await radioGet(req(), ctx({ ...w.sid, id: "nope" }))).status).toBe(404);
    h.resolution = null;
    h.profile = null;
    expect((await radioGet(req(), ctx({ ...w.sid, id: w.a.id }))).status).not.toBe(200);
  });
});
