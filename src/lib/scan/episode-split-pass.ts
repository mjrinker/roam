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
import { planCombinedTrims, type FileChapter, type OwnerRow } from "@/lib/scan/episode-split";

type CandidateRow = {
  id: string;
  ownerId: string;
  boxFileId: string;
  partIndex: number;
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
 * Simple union-find over Box file ids, used to cluster every physical
 * part of one combined multi-episode file together — including when it's
 * ALSO split across multiple physical files (pt1/pt2/...). Two box file
 * ids are unioned whenever some episode owns rows for both, which is
 * exactly what "these are parts of the same combined file" means (every
 * owning episode owns EVERY part). Grouping this way, rather than by a
 * parsed episode-number string, avoids accidentally merging two
 * UNRELATED shows' files that happen to claim the same episode numbers.
 */
class BoxFileUnionFind {
  private parent = new Map<string, string>();

  private root(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let cur = x;
    while (this.parent.get(cur) !== r) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, r);
      cur = next;
    }
    return r;
  }

  union(a: string, b: string) {
    const ra = this.root(a);
    const rb = this.root(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  find(x: string): string {
    return this.root(x);
  }
}

/**
 * Recomputes and applies trim windows for every combined (multi-episode)
 * file among the given episodes' media_files rows — including one that's
 * ALSO split across multiple physical parts, in which case a single
 * episode's window can land across a part boundary and become two (or
 * more) trimmed segments for that one episode; the seamless player
 * already knows how to play multiple segments for one owner, so nothing
 * there needs special-casing. `episodeIds` scopes the whole pass (a
 * season, a show, or a whole library's worth) — the caller decides how
 * wide.
 */
export async function resolveEpisodeSplits(episodeIds: string[]): Promise<void> {
  if (episodeIds.length === 0) return;

  const selected = await db
    .select({
      id: mediaFiles.id,
      ownerId: mediaFiles.ownerId,
      boxFileId: mediaFiles.boxFileId,
      partIndex: mediaFiles.partIndex,
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
  // ownerId is guaranteed non-null here (the ownerKind="episode" filter
  // above never matches a variant row, whose ownerKind is null) — this
  // just satisfies ownerId's now-nullable type (see schema.ts).
  const rows: CandidateRow[] = selected
    .filter((r) => r.ownerId !== null)
    .map((r) => ({ ...r, ownerId: r.ownerId as string }));
  if (rows.length === 0) return;

  // How many media_files rows each episode owns in total — used to detect
  // an episode that ALSO owns some other, unrelated file (planCombinedTrims
  // treats that as a case not worth reasoning about further).
  const rowCountByOwner = new Map<string, number>();
  for (const row of rows) rowCountByOwner.set(row.ownerId, (rowCountByOwner.get(row.ownerId) ?? 0) + 1);

  // Every row sharing a Box file id, across ALL owners — used below to
  // find a probed duration/chapters for a part even if THIS particular
  // owner's copy of it hasn't been probed yet (each owner's row for a
  // shared file is probed independently; see media-files.ts).
  const rowsByBoxFileId = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    const list = rowsByBoxFileId.get(row.boxFileId) ?? [];
    list.push(row);
    rowsByBoxFileId.set(row.boxFileId, list);
  }

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

  const uf = new BoxFileUnionFind();
  const boxFileIdsByOwner = new Map<string, Set<string>>();
  for (const row of candidates) {
    const set = boxFileIdsByOwner.get(row.ownerId) ?? new Set<string>();
    set.add(row.boxFileId);
    boxFileIdsByOwner.set(row.ownerId, set);
  }
  for (const boxFileIds of boxFileIdsByOwner.values()) {
    const [first, ...rest] = boxFileIds;
    for (const other of rest) uf.union(first, other);
  }

  const groupsByRoot = new Map<string, CandidateRow[]>();
  for (const row of candidates) {
    const root = uf.find(row.boxFileId);
    const list = groupsByRoot.get(root) ?? [];
    list.push(row);
    groupsByRoot.set(root, list);
  }

  const ownerIds = [...new Set(candidates.map((row) => row.ownerId))];
  const ownerEpisodes = await db
    .select({ id: episodes.id, number: episodes.number, runtimeSeconds: episodes.runtimeSeconds })
    .from(episodes)
    .where(inArray(episodes.id, ownerIds));
  const episodeById = new Map(ownerEpisodes.map((ep) => [ep.id, ep]));

  for (const groupRows of groupsByRoot.values()) {
    const parsedEpisodes = parseEpisodeFileName(groupRows[0].filename)?.episodes ?? [];

    // This block's distinct physical parts, in playback order. Duration
    // and chapters come from the first PROBED row found across ANY owner
    // of this Box file id — each owner's copy is probed independently, so
    // one owner's copy can lag another's.
    const distinctBoxFileIds = [...new Set(groupRows.map((r) => r.boxFileId))];
    const parts = distinctBoxFileIds
      .map((boxFileId) => {
        const reps = rowsByBoxFileId.get(boxFileId) ?? [];
        const probedRow = reps.find((r) => r.durationSeconds != null);
        const durationSeconds = probedRow
          ? (probedRow.durationMs ?? probedRow.durationSeconds! * 1000) / 1000
          : null;
        const chapters = reps.find((r) => r.chapters != null)?.chapters ?? null;
        const partIndex = reps[0]?.partIndex ?? 0;
        return { boxFileId, durationSeconds, chapters, partIndex };
      })
      .sort((a, b) => a.partIndex - b.partIndex)
      .map(({ boxFileId, durationSeconds, chapters }) => ({ boxFileId, durationSeconds, chapters }));

    const ownerIdsInGroup = [...new Set(groupRows.map((r) => r.ownerId))];
    const owners: OwnerRow[] = ownerIdsInGroup.map((ownerId) => {
      const ep = episodeById.get(ownerId);
      const ownerRowsInGroup = groupRows.filter((r) => r.ownerId === ownerId);
      const trimSource = ownerRowsInGroup.some((r) => r.trimSource === "manual")
        ? "manual"
        : (ownerRowsInGroup.find((r) => r.trimSource != null)?.trimSource ?? null);
      return {
        episodeNumber: ep?.number ?? -1,
        ownerRowCount: rowCountByOwner.get(ownerId) ?? 1,
        runtimeSeconds: ep?.runtimeSeconds ?? null,
        trimSource,
      };
    });

    const target = planCombinedTrims({ parsedEpisodes, owners, parts });
    if (target.kind === "skip") continue;

    const windowByKey =
      target.kind === "split"
        ? new Map(target.windows.map((w) => [`${w.episodeNumber}:${w.boxFileId}`, w]))
        : null;

    for (const row of groupRows) {
      const ep = episodeById.get(row.ownerId);
      const window = windowByKey && ep ? windowByKey.get(`${ep.number}:${row.boxFileId}`) : undefined;

      const rowTarget =
        target.kind === "reset"
          ? { trimStartSeconds: null, trimDurationSeconds: null, trimSource: null as "auto" | "manual" | null }
          : target.kind === "whole"
            ? { trimStartSeconds: null, trimDurationSeconds: null, trimSource: "auto" as const }
            : window
              ? {
                  trimStartSeconds: window.trimStartSeconds,
                  trimDurationSeconds: window.trimDurationSeconds,
                  trimSource: "auto" as const,
                }
              : // A "split" target with no window for THIS (episode, part)
                // pair means the episode's window simply doesn't touch
                // this particular part at all (a real, expected outcome
                // once a combined file spans multiple physical parts) —
                // exclude the row from this episode's playback. The
                // manifest filters out a zero-duration trim.
                { trimStartSeconds: 0, trimDurationSeconds: 0, trimSource: "auto" as const };

      if (!trimTargetsDiffer(row, rowTarget)) continue;
      await db.update(mediaFiles).set(rowTarget).where(eq(mediaFiles.id, row.id));
    }
  }
}
