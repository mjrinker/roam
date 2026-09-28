/**
 * Applies episode-split.ts's pure math to real media_files rows. Kept
 * separate from scanner.ts so scanner.ts can import this without this
 * module needing to import back from scanner.ts (it takes episode ids as
 * an argument rather than looking them up itself).
 *
 * Makes no external calls (no Box, no TMDB), so resolveEpisodeSplits is
 * cheap enough to re-run on every scan pass with no "already attempted"
 * stamp — a later-arriving runtime, a replaced file, or a standalone file
 * added/removed all just get picked up on the next call.
 *
 * Deploy-2 code: this assumes a multi-episode file's owning episodes each
 * already have their OWN media_files row for that file (rather than one
 * episode's upsert stealing another's), which requires the scoped upsert
 * conflict target in media-files.ts AND the box_file_id global unique
 * constraint drop to both be live in production first. Calling this before
 * then is harmless (there's nothing to find — see the "no candidates"
 * early-return below — since the older global-unique-target code can only
 * ever leave one row per Box file), just pointless.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, mediaFiles } from "@/lib/db/schema";
import { parseEpisodeFileName } from "@/lib/scan/conventions";
import { planFileTrims, type FileChapter, type OwnerRow } from "@/lib/scan/episode-split";

type CandidateRow = {
  id: string;
  ownerId: string;
  boxFileId: string;
  filename: string;
  durationSeconds: number | null;
  durationMs: number | null;
  chapters: FileChapter[] | null;
  trimStartSeconds: number | null;
  trimDurationSeconds: number | null;
  trimSource: "auto" | "manual" | null;
};

function trimTargetsDiffer(
  row: Pick<CandidateRow, "trimStartSeconds" | "trimDurationSeconds" | "trimSource">,
  target: { trimStartSeconds: number | null; trimDurationSeconds: number | null; trimSource: "auto" | "manual" | null }
): boolean {
  if (row.trimSource !== target.trimSource) return true;
  if ((row.trimStartSeconds == null) !== (target.trimStartSeconds == null)) return true;
  if ((row.trimDurationSeconds == null) !== (target.trimDurationSeconds == null)) return true;
  if (
    row.trimStartSeconds != null &&
    target.trimStartSeconds != null &&
    Math.abs(row.trimStartSeconds - target.trimStartSeconds) > 0.01
  ) {
    return true;
  }
  if (
    row.trimDurationSeconds != null &&
    target.trimDurationSeconds != null &&
    Math.abs(row.trimDurationSeconds - target.trimDurationSeconds) > 0.01
  ) {
    return true;
  }
  return false;
}

/**
 * Recomputes and applies trim windows for every combined (multi-episode)
 * file among the given episodes' media_files rows. `episodeIds` scopes the
 * whole pass (a season, a show, or a whole library's worth) — the caller
 * decides how wide.
 */
export async function resolveEpisodeSplits(episodeIds: string[]): Promise<void> {
  if (episodeIds.length === 0) return;

  const rows: CandidateRow[] = await db
    .select({
      id: mediaFiles.id,
      ownerId: mediaFiles.ownerId,
      boxFileId: mediaFiles.boxFileId,
      filename: mediaFiles.filename,
      durationSeconds: mediaFiles.durationSeconds,
      durationMs: mediaFiles.durationMs,
      chapters: mediaFiles.chapters,
      trimStartSeconds: mediaFiles.trimStartSeconds,
      trimDurationSeconds: mediaFiles.trimDurationSeconds,
      trimSource: mediaFiles.trimSource,
    })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, "episode"), inArray(mediaFiles.ownerId, episodeIds)));
  if (rows.length === 0) return;

  // How many media_files rows each episode owns in total — a multi-PART
  // (not multi-episode) episode fails planFileTrims' "no multi-part combined
  // file" check, so this has to count every row for the owner, not just
  // the ones sharing one boxFileId.
  const rowCountByOwner = new Map<string, number>();
  for (const row of rows) rowCountByOwner.set(row.ownerId, (rowCountByOwner.get(row.ownerId) ?? 0) + 1);

  // Only worth looking at: a file whose name currently parses to 2+
  // episodes, OR one that has a leftover trim from when it USED to
  // (renamed away from a combined form since the last pass) — everything
  // else has never had, and still doesn't have, anything to compute.
  const candidates = rows.filter(
    (row) =>
      (parseEpisodeFileName(row.filename)?.episodes.length ?? 0) > 1 ||
      row.trimSource != null ||
      row.trimStartSeconds != null ||
      row.trimDurationSeconds != null
  );
  if (candidates.length === 0) return;

  const byBoxFileId = new Map<string, CandidateRow[]>();
  for (const row of candidates) {
    const list = byBoxFileId.get(row.boxFileId) ?? [];
    list.push(row);
    byBoxFileId.set(row.boxFileId, list);
  }

  const ownerIds = [...new Set(candidates.map((row) => row.ownerId))];
  const ownerEpisodes = await db
    .select({ id: episodes.id, number: episodes.number, runtimeSeconds: episodes.runtimeSeconds })
    .from(episodes)
    .where(inArray(episodes.id, ownerIds));
  const episodeById = new Map(ownerEpisodes.map((ep) => [ep.id, ep]));

  for (const siblings of byBoxFileId.values()) {
    const parsedEpisodes = parseEpisodeFileName(siblings[0].filename)?.episodes ?? [];
    const owners: OwnerRow[] = siblings.map((row) => {
      const ep = episodeById.get(row.ownerId);
      return {
        episodeNumber: ep?.number ?? -1,
        ownerRowCount: rowCountByOwner.get(row.ownerId) ?? 1,
        runtimeSeconds: ep?.runtimeSeconds ?? null,
        trimSource: row.trimSource,
      };
    });

    const allProbed = siblings.every((row) => row.durationSeconds != null);
    const first = siblings[0];
    const fileSeconds = allProbed ? (first.durationMs ?? (first.durationSeconds ?? 0) * 1000) / 1000 : null;
    const chapters = siblings.find((row) => row.chapters != null)?.chapters ?? null;

    const target = planFileTrims({ parsedEpisodes, owners, fileSeconds, chapters });
    if (target.kind === "skip") continue;

    const windowByEpisode =
      target.kind === "split" ? new Map(target.windows.map((w) => [w.episodeNumber, w])) : null;

    for (const row of siblings) {
      const ep = episodeById.get(row.ownerId);
      const window = windowByEpisode && ep ? windowByEpisode.get(ep.number) : undefined;
      const rowTarget =
        target.kind === "reset"
          ? { trimStartSeconds: null, trimDurationSeconds: null, trimSource: null as "auto" | "manual" | null }
          : target.kind === "whole"
            ? { trimStartSeconds: null, trimDurationSeconds: null, trimSource: "auto" as const }
            : window
              ? { trimStartSeconds: window.startSeconds, trimDurationSeconds: window.durationSeconds, trimSource: "auto" as const }
              : // A split target with no window for this row (its episode
                // wasn't found) shouldn't happen — planFileTrims only
                // returns "split" when owners exactly match parsedEpisodes
                // — but fall back to whole rather than write nothing.
                { trimStartSeconds: null, trimDurationSeconds: null, trimSource: "auto" as const };

      if (!trimTargetsDiffer(row, rowTarget)) continue;
      await db.update(mediaFiles).set(rowTarget).where(eq(mediaFiles.id, row.id));
    }
  }
}
