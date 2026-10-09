import { db } from "@/lib/db/client";
import { episodes, musicAlbums, musicArtists, titles } from "@/lib/db/schema";
import { albumSongIds, artistSongIds } from "@/lib/music/browse";
import { eq } from "drizzle-orm";
import { asUuid, notFoundPage, tvAccess } from "@/lib/tv/context";
import { safeBack, sameHost } from "@/lib/tv/form";
import { html } from "@/lib/tv/http";
import { tvPlaylists } from "@/lib/tv/playlists";
import { findAddableTarget } from "@/lib/playlists/items";
import { addItem, addSongs, MAX_SONGS_PER_ADD } from "@/lib/playlists/item-service";
import { addToPlaylistPage, messagePage } from "@/tv/render";

const targetFrom = (get: (name: string) => string | null | undefined) => {
  const title = asUuid(get("title") ?? "");
  const episode = asUuid(get("episode") ?? "");
  const album = asUuid(get("album") ?? "");
  const artist = asUuid(get("artist") ?? "");
  return title ? { field: "title" as const, id: title } : episode ? { field: "episode" as const, id: episode } : album ? { field: "album" as const, id: album } : artist ? { field: "artist" as const, id: artist } : null;
};

/** The playlists this profile can add to, for something it may see. */
export async function GET(request: Request, ctx: RouteContext<"/tv/s/[serverId]/add">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const query = new URL(request.url).searchParams;
  const target = targetFrom((n) => query.get(n));
  if (!target) return notFoundPage();
  const scope = { actor: access.scope.actor, viewer: access.scope.viewer };
  let what = "";
  if (target.field === "album" || target.field === "artist") {
    // all of its songs this profile may see; nothing visible means it isn't there
    const ids = target.field === "album" ? await albumSongIds(db, { ...scope, albumId: target.id }) : await artistSongIds(db, { ...scope, artistId: target.id }, MAX_SONGS_PER_ADD);
    if (!ids?.length) return notFoundPage();
    what = target.field === "album"
      ? `${(await db.select({ name: musicAlbums.name }).from(musicAlbums).where(eq(musicAlbums.id, target.id)))[0]?.name ?? "Album"} · ${ids.length} ${ids.length === 1 ? "song" : "songs"}`
      : `${(await db.select({ name: musicArtists.name }).from(musicArtists).where(eq(musicArtists.id, target.id)))[0]?.name ?? "Artist"} · ${ids.length} ${ids.length === 1 ? "song" : "songs"}`;
  } else {
    const addable = await findAddableTarget(db, { lib: access.scope.actor, viewer: access.scope.viewer, ...(target.field === "title" ? { titleId: target.id } : { episodeId: target.id }) });
    if (!addable) return notFoundPage();
    if (target.field === "title") what = (await db.select({ name: titles.name }).from(titles).where(eq(titles.id, target.id)))[0]?.name ?? "";
    else what = (await db.select({ name: episodes.name }).from(episodes).where(eq(episodes.id, target.id)))[0]?.name ?? "This episode";
  }
  const lists = (await tvPlaylists(db, access.scope)).filter((p) => p.canAdd);
  return html(
    addToPlaylistPage({
      base: access.base,
      what,
      target,
      back: safeBack(access.base, query.get("back")),
      playlists: lists.map((p) => ({ id: p.id, name: p.name, note: `${p.itemCount} ${p.itemCount === 1 ? "item" : "items"}` })),
    })
  );
}

/** Adds it. Only a POST changes anything, and a POST from another site is refused. */
export async function POST(request: Request, ctx: RouteContext<"/tv/s/[serverId]/add">) {
  const serverId = asUuid((await ctx.params).serverId);
  if (!serverId) return notFoundPage();
  const origin = request.headers.get("origin");
  if (origin && !sameHost(origin, request.url)) return notFoundPage();
  const access = await tvAccess(request, serverId);
  if (!access.ok) return access.response;
  const form = await request.formData().catch(() => null);
  if (!form) return notFoundPage(); // not a form post
  const field = (n: string) => (typeof form.get(n) === "string" ? (form.get(n) as string) : null);
  const target = targetFrom(field);
  const playlistId = asUuid(field("playlist") ?? "");
  if (!target || !playlistId) return notFoundPage();
  const back = safeBack(access.base, field("back"));
  if (target.field === "album" || target.field === "artist") {
    const songs = await addSongs(db, { playlistId, viewerId: access.scope.viewerId, ...(target.field === "album" ? { albumId: target.id } : { artistId: target.id }) });
    const page = (title: string, message: string, status = 200) => html(messagePage(title, message, { href: back, label: "Back" }), status);
    if (!songs.ok) return page("Couldn't add them", "That playlist can't be changed.", 404);
    const { added, skipped } = songs.value;
    if (added === 0) return page("Already there", "Those songs are already in this playlist.");
    return page("Added", `Added ${added} ${added === 1 ? "song" : "songs"} to your playlist${skipped ? ` (${skipped} already there)` : ""}.`);
  }
  const result = await addItem(db, { playlistId, viewerId: access.scope.viewerId, ...(target.field === "title" ? { titleId: target.id } : { episodeId: target.id }) });
  const done = (title: string, message: string) => html(messagePage(title, message, { href: back, label: "Back" }), result.ok ? 200 : result.status === 409 ? 200 : 404);
  if (result.ok) return done("Added", "Added to your playlist.");
  if (result.status === 409) return done("Already there", "That is already in this playlist.");
  return done("Couldn't add it", "That playlist can't be changed.");
}
