import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, titles } from "@/lib/db/schema";
import { html } from "@/lib/tv/http";
import { addItem, addSongs } from "@/lib/playlists/item-service";
import { messagePage } from "@/tv/render";

export type AddTarget = { field: "title" | "episode" | "album" | "artist"; id: string };

/** Adds a title, episode, album or artist (its songs) to a playlist this profile may change, and answers with a message page. */
export async function addTargetToPlaylist(viewerId: string, args: { playlistId: string; target: AddTarget; back: string }): Promise<Response> {
  const { playlistId, target, back } = args;
  if (target.field === "album" || target.field === "artist") {
    const songs = await addSongs(db, { playlistId, viewerId, ...(target.field === "album" ? { albumId: target.id } : { artistId: target.id }) });
    const page = (title: string, message: string, status = 200) => html(messagePage(title, message, { href: back, label: "Back" }), status);
    if (!songs.ok) return page("Couldn't add them", "That playlist can't be changed.", 404);
    const { added, skipped, remaining } = songs.value;
    if (added === 0) return page("Already there", "Those songs are already in this playlist.");
    return page("Added", `Added ${added} ${added === 1 ? "song" : "songs"} to your playlist${skipped ? ` (${skipped} already there)` : ""}.${remaining > 0 ? ` ${remaining} more didn't fit this time: add again to continue.` : ""}`);
  }
  const result = await addItem(db, { playlistId, viewerId, ...(target.field === "title" ? { titleId: target.id } : { episodeId: target.id }) });
  const done = (title: string, message: string) => html(messagePage(title, message, { href: back, label: "Back" }), result.ok ? 200 : result.status === 409 ? 200 : 404);
  if (result.ok) return done("Added", "Added to your playlist.");
  if (result.status === 409) return done("Already there", "That is already in this playlist.");
  return done("Couldn't add it", "That playlist can't be changed.");
}

/** The name of what is being added (for a heading), when it is a movie, show or episode. */
export async function addTargetName(target: AddTarget): Promise<string | null> {
  if (target.field === "title") return (await db.select({ n: titles.name }).from(titles).where(eq(titles.id, target.id)))[0]?.n ?? null;
  if (target.field === "episode") return (await db.select({ n: episodes.name }).from(episodes).where(eq(episodes.id, target.id)))[0]?.n ?? null;
  return null;
}
