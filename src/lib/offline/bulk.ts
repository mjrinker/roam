/** Download choices for many titles at once (the ones selected on a library page). Server side. */
import { and, asc, eq, exists } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, mediaFiles, seasons, titles } from "@/lib/db/schema";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { buildDownloadOptions } from "./build-options";
import type { DownloadOptions } from "./options";

export const MAX_BULK_TITLES = 300;
/** A selection of whole shows can hold far more than this; past it the rest is left out and the caller is told. */
export const MAX_BULK_ITEMS = 1500;
const AT_ONCE = 6;

/** A show's episodes that have files, in order. */
async function episodeIdsOf(showId: string): Promise<string[]> {
  const rows = await db
    .select({ id: episodes.id })
    .from(episodes)
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .where(and(eq(seasons.titleId, showId), exists(db.select({ one: mediaFiles.id }).from(mediaFiles).where(and(eq(mediaFiles.ownerKind, "episode"), eq(mediaFiles.ownerId, episodes.id))))))
    .orderBy(asc(seasons.number), asc(episodes.number));
  return rows.map((r) => r.id);
}

/**
 * The download choices for each selected title the caller may download: a movie or audiobook is one item, a show becomes all of its
 * episodes. Titles that can't be downloaded (not allowed, nothing to download yet) are counted, never named.
 */
export async function bulkDownloadOptions(titleIds: string[]): Promise<{ items: DownloadOptions[]; skipped: number; truncated: boolean }> {
  const ids = [...new Set(titleIds)].slice(0, MAX_BULK_TITLES);
  const owners: { kind: "title" | "episode"; id: string }[] = [];
  let skipped = 0;
  for (let i = 0; i < ids.length; i += AT_ONCE) {
    const checked = await Promise.all(
      ids.slice(i, i + AT_ONCE).map(async (id) => {
        const auth = await authorizeOwner("title", id, { titleKinds: ["movie", "show", "audiobook"] });
        if (!auth.ok) return null;
        const [t] = await db.select({ kind: titles.kind }).from(titles).where(eq(titles.id, id)).limit(1);
        if (!t) return null;
        return t.kind === "show" ? (await episodeIdsOf(id)).map((e) => ({ kind: "episode" as const, id: e })) : [{ kind: "title" as const, id }];
      })
    );
    for (const group of checked) {
      if (!group || group.length === 0) skipped++;
      else owners.push(...group);
    }
  }
  const truncated = owners.length > MAX_BULK_ITEMS;
  const wanted = owners.slice(0, MAX_BULK_ITEMS);
  const items: DownloadOptions[] = [];
  for (let i = 0; i < wanted.length; i += AT_ONCE) {
    const built = await Promise.all(wanted.slice(i, i + AT_ONCE).map((o) => buildDownloadOptions(o.kind, o.id)));
    for (const b of built) {
      if (b && b.options.length > 0) items.push(b);
      else skipped++;
    }
  }
  return { items, skipped, truncated };
}
