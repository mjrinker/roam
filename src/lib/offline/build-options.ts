/** What can be downloaded for a movie, episode, song or audiobook: each version with its resolution and file size. Server side. */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, mediaFiles, seasons, titles } from "@/lib/db/schema";
import { describeVersions, groupRowsByVersion, offeredRows, versionBytes } from "@/lib/player/versions";
import type { PlayOwnerKind } from "@/lib/player/types";
import type { DownloadOption, DownloadOptions } from "./options";

/** Null when the owner has no files to offer (nothing downloadable yet). */
export async function buildDownloadOptions(ownerKind: PlayOwnerKind, ownerId: string): Promise<DownloadOptions | null> {
  const everyRow = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, ownerKind), eq(mediaFiles.ownerId, ownerId)))
    .orderBy(asc(mediaFiles.versionLabel), asc(mediaFiles.partIndex));
  if (everyRow.length === 0) return null;

  let title = "";
  let subtitle: string | null = null;
  let posterUrl: string | null = null;
  let kind: DownloadOptions["kind"] = "watch";
  if (ownerKind === "title") {
    const [t] = await db.select({ name: titles.name, year: titles.year, kind: titles.kind, posterUrl: titles.posterUrl }).from(titles).where(eq(titles.id, ownerId)).limit(1);
    if (!t) return null;
    title = t.name;
    subtitle = t.year ? String(t.year) : null;
    posterUrl = t.posterUrl;
    kind = t.kind === "audiobook" ? "listen" : "watch";
  } else {
    const [e] = await db
      .select({ show: titles.name, showPoster: titles.posterUrl, season: seasons.number, number: episodes.number, name: episodes.name, still: episodes.stillUrl })
      .from(episodes)
      .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
      .innerJoin(titles, eq(seasons.titleId, titles.id))
      .where(eq(episodes.id, ownerId))
      .limit(1);
    if (!e) return null;
    title = e.show;
    subtitle = `S${e.season} · E${e.number}${e.name ? ` · ${e.name}` : ""}`;
    posterUrl = e.still ?? e.showPoster;
  }

  const offered = offeredRows(everyRow);
  const byLabel = groupRowsByVersion(offered);
  const options: DownloadOption[] =
    kind === "listen"
      ? [{ label: "", name: "Audio", height: null, sizeBytes: versionBytes(offered), parts: new Set(offered.map((r) => r.boxFileId)).size }]
      : describeVersions(offered).map((v) => {
          const rows = byLabel.get(v.label) ?? [];
          return { label: v.label, name: v.name, height: v.height, sizeBytes: versionBytes(rows), parts: new Set(rows.map((r) => r.boxFileId)).size };
        });
  return { kind, ownerKind, ownerId, title, subtitle, posterUrl, options };
}
