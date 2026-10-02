/** What plays next inside a playlist queue, on real data. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { episodes } from "@/lib/db/schema";
import { candidateEpisodes, nextAfter } from "./next";
import {
  addEpisodeFile,
  addItem,
  createTestDb,
  makeAccount,
  makeLibrary,
  makePlaylist,
  makeServer,
  makeShow,
  makeTitle,
  makeViewer,
  setProgress,
  type TestDb,
} from "./test-db";

let db: TestDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

async function world() {
  const owner = await makeAccount(db, "owner");
  const server = await makeServer(db, owner.accountId);
  const library = await makeLibrary(db, server.id);
  const playlist = await makePlaylist(db, { serverId: server.id, ownerViewerId: owner.viewer.id });
  return { owner, server, library, playlist };
}

/** A show whose episodes all have media files, so every one is a candidate. */
async function playableShow(libraryId: string, count: number, over = {}) {
  const s = await makeShow(db, libraryId, count, over);
  for (const e of s.episodes) await addEpisodeFile(db, e.id);
  return s;
}

const hrefOf = async (args: Parameters<typeof nextAfter>[1]) => {
  const r = await nextAfter(db, args);
  return r.ok ? r.value : "error";
};

describe("nextAfter — one stop per movie", () => {
  it("moves through movies in order, then ends", async () => {
    const { owner, server, library, playlist } = await world();
    const m1 = await makeTitle(db, library.id, { name: "M1" });
    const m2 = await makeTitle(db, library.id, { name: "M2" });
    const i1 = await addItem(db, playlist.id, { titleId: m1.id }, 1024);
    const i2 = await addItem(db, playlist.id, { titleId: m2.id }, 2048);

    const next = await hrefOf({ playlistId: playlist.id, viewerId: owner.viewer.id, afterItemId: i1.id });
    expect(next).toEqual({
      itemId: i2.id,
      kind: "movie",
      id: m2.id,
      href: `/s/${server.id}/watch/title/${m2.id}?playlist=${playlist.id}&item=${i2.id}`,
      replay: false,
    });
    expect(await hrefOf({ playlistId: playlist.id, viewerId: owner.viewer.id, afterItemId: i2.id })).toBeNull();
  });

  it("returns a book page link for an audiobook entry", async () => {
    const { owner, server, library, playlist } = await world();
    const movie = await makeTitle(db, library.id);
    const book = await makeTitle(db, library.id, { kind: "audiobook" });
    const i1 = await addItem(db, playlist.id, { titleId: movie.id }, 1024);
    const i2 = await addItem(db, playlist.id, { titleId: book.id }, 2048);
    expect(await hrefOf({ playlistId: playlist.id, viewerId: owner.viewer.id, afterItemId: i1.id })).toMatchObject({
      kind: "audiobook",
      id: book.id,
      href: `/s/${server.id}/book/${book.id}?playlist=${playlist.id}&item=${i2.id}`,
    });
  });

  it("skips items the viewer may not see, without revealing them", async () => {
    const { owner, library, playlist } = await world();
    const kid = await makeViewer(db, owner.accountId, { role: "limited", maxAge: 12, allowUnrated: false });
    const own = await makePlaylist(db, { serverId: playlist.serverId, ownerViewerId: kid.id });
    const a = await makeTitle(db, library.id, { ratingAges: { US: 0 } });
    const blocked = await makeTitle(db, library.id, { ratingAges: { US: 17 } });
    const c = await makeTitle(db, library.id, { ratingAges: { US: 4 } });
    const ia = await addItem(db, own.id, { titleId: a.id }, 1024);
    await addItem(db, own.id, { titleId: blocked.id }, 2048);
    await addItem(db, own.id, { titleId: c.id }, 3072);
    const next = await hrefOf({ playlistId: own.id, viewerId: kid.id, afterItemId: ia.id });
    expect(next).toMatchObject({ kind: "movie", id: c.id });
  });

  it("is a 404 when the item is gone or the viewer can't see the playlist", async () => {
    const { owner, library, playlist } = await world();
    const stranger = await makeAccount(db, "s");
    const t = await makeTitle(db, library.id);
    const item = await addItem(db, playlist.id, { titleId: t.id });
    expect(await nextAfter(db, { playlistId: playlist.id, viewerId: owner.viewer.id, afterItemId: "00000000-0000-4000-8000-0000000000cc" })).toMatchObject({ ok: false, status: 404 });
    expect(await nextAfter(db, { playlistId: playlist.id, viewerId: stranger.viewer.id, afterItemId: item.id })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("nextAfter — show entries", () => {
  it("starts a show at the viewer's next unwatched episode, not episode 1", async () => {
    const { owner, server, library, playlist } = await world();
    const movie = await makeTitle(db, library.id);
    const { show, episodes: eps } = await playableShow(library.id, 3);
    await setProgress(db, owner.viewer.id, eps[0].id, { finished: true });
    const i1 = await addItem(db, playlist.id, { titleId: movie.id }, 1024);
    const i2 = await addItem(db, playlist.id, { titleId: show.id }, 2048);
    const next = await hrefOf({ playlistId: playlist.id, viewerId: owner.viewer.id, afterItemId: i1.id });
    expect(next).toMatchObject({
      kind: "episode",
      id: eps[1].id,
      replay: false,
      href: `/s/${server.id}/watch/episode/${eps[1].id}?playlist=${playlist.id}&item=${i2.id}`,
    });
  });

  it("steps through the show's episodes, skipping finished ones, then moves to the next item", async () => {
    const { owner, library, playlist } = await world();
    const { show, episodes: eps } = await playableShow(library.id, 4);
    const after = await makeTitle(db, library.id, { name: "After" });
    const showItem = await addItem(db, playlist.id, { titleId: show.id }, 1024);
    const afterItem = await addItem(db, playlist.id, { titleId: after.id }, 2048);
    await setProgress(db, owner.viewer.id, eps[2].id, { finished: true });

    const step = (episodeId: string) =>
      hrefOf({ playlistId: playlist.id, viewerId: owner.viewer.id, afterItemId: showItem.id, currentEpisodeId: episodeId });
    expect(await step(eps[0].id)).toMatchObject({ kind: "episode", id: eps[1].id });
    expect(await step(eps[1].id)).toMatchObject({ kind: "episode", id: eps[3].id }); // e3 is finished
    expect(await step(eps[3].id)).toMatchObject({ kind: "movie", id: after.id, itemId: afterItem.id });
  });

  it("replays a fully watched show from its first episode and keeps stepping in replay mode", async () => {
    const { owner, library, playlist } = await world();
    const movie = await makeTitle(db, library.id);
    const { show, episodes: eps } = await playableShow(library.id, 3);
    for (const e of eps) await setProgress(db, owner.viewer.id, e.id, { finished: true });
    const i1 = await addItem(db, playlist.id, { titleId: movie.id }, 1024);
    const showItem = await addItem(db, playlist.id, { titleId: show.id }, 2048);

    const start = await hrefOf({ playlistId: playlist.id, viewerId: owner.viewer.id, afterItemId: i1.id });
    expect(start).toMatchObject({ kind: "episode", id: eps[0].id, replay: true });
    expect(typeof start !== "string" && start && start.href).toContain("&replay=1");
    const step = await hrefOf({ playlistId: playlist.id, viewerId: owner.viewer.id, afterItemId: showItem.id, currentEpisodeId: eps[0].id, replay: true });
    expect(step).toMatchObject({ kind: "episode", id: eps[1].id, replay: true });
  });

  it("skips a show entry that has no playable episodes", async () => {
    const { owner, library, playlist } = await world();
    const movie = await makeTitle(db, library.id, { name: "First" });
    const { show } = await makeShow(db, library.id, 2); // no media files
    const last = await makeTitle(db, library.id, { name: "Last" });
    const i1 = await addItem(db, playlist.id, { titleId: movie.id }, 1024);
    await addItem(db, playlist.id, { titleId: show.id }, 2048);
    await addItem(db, playlist.id, { titleId: last.id }, 3072);
    expect(await hrefOf({ playlistId: playlist.id, viewerId: owner.viewer.id, afterItemId: i1.id })).toMatchObject({ kind: "movie", id: last.id });
  });

  it("plays an episode item as one stop and ignores a current episode on it", async () => {
    const { owner, library, playlist } = await world();
    const { episodes: eps } = await playableShow(library.id, 2);
    const next = await makeTitle(db, library.id);
    const epItem = await addItem(db, playlist.id, { episodeId: eps[0].id }, 1024);
    await addItem(db, playlist.id, { titleId: next.id }, 2048);
    expect(await hrefOf({ playlistId: playlist.id, viewerId: owner.viewer.id, afterItemId: epItem.id, currentEpisodeId: eps[0].id })).toMatchObject({ kind: "movie", id: next.id });
  });

  it("skips a show whose rating blocks the viewer", async () => {
    const { owner, server, library } = await world();
    const kid = await makeViewer(db, owner.accountId, { role: "limited", maxAge: 12, allowUnrated: false });
    const own = await makePlaylist(db, { serverId: server.id, ownerViewerId: kid.id });
    const first = await makeTitle(db, library.id, { ratingAges: { US: 0 } });
    const { show } = await playableShow(library.id, 2, { ratingAges: { US: 17 } });
    const last = await makeTitle(db, library.id, { ratingAges: { US: 0 } });
    const i1 = await addItem(db, own.id, { titleId: first.id }, 1024);
    await addItem(db, own.id, { titleId: show.id }, 2048);
    await addItem(db, own.id, { titleId: last.id }, 3072);
    expect(await hrefOf({ playlistId: own.id, viewerId: kid.id, afterItemId: i1.id })).toMatchObject({ kind: "movie", id: last.id });
  });
});

describe("candidateEpisodes", () => {
  it("returns only episodes with media files, with the viewer's own progress", async () => {
    const { owner, library } = await world();
    const { show, episodes: eps } = await makeShow(db, library.id, 3);
    await addEpisodeFile(db, eps[0].id);
    await addEpisodeFile(db, eps[1].id);
    await setProgress(db, owner.viewer.id, eps[1].id, { positionSeconds: 90 });
    const other = await makeAccount(db, "other");
    await setProgress(db, other.viewer.id, eps[0].id, { finished: true }); // someone else's progress
    const got = await candidateEpisodes(db, { showId: show.id, viewerId: owner.viewer.id });
    expect(got.map((c) => c.id).sort()).toEqual([eps[0].id, eps[1].id].sort());
    const e1 = got.find((c) => c.id === eps[1].id)!;
    expect(e1).toMatchObject({ finished: false, progressSeconds: 90 });
    expect(got.find((c) => c.id === eps[0].id)).toMatchObject({ finished: false, progressSeconds: 0 });
    expect(await db.select().from(episodes).where(eq(episodes.id, eps[2].id))).toHaveLength(1);
  });
});
