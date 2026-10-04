/**
 * The age rating of a video ("generic") library. Videos carry no rating of their own, so the admin
 * rates the whole library. It is stored on the library and COPIED onto every title in it as
 * `{ ANY: minimumAge }` (the catch-all key lib/content/access already understands), so the existing
 * age filter works unchanged. null = unrated: each profile's "allow unrated" setting decides.
 */
import { eq, sql } from "drizzle-orm";
import { libraries, titles } from "@/lib/db/schema";
import type { Db } from "@/lib/scan/media-files";

/** Minimum age that may see the library, or null for unrated. */
export type VideoRating = number | null;

export const VIDEO_RATING_OPTIONS: { value: VideoRating; label: string }[] = [
  { value: 0, label: "All ages" },
  { value: 7, label: "7 and up" },
  { value: 10, label: "10 and up" },
  { value: 13, label: "13 and up" },
  { value: 17, label: "17 and up" },
  { value: 18, label: "Adults only (18+)" },
  { value: null, label: "Unrated (each profile's own setting decides)" },
];

export function isVideoRating(value: unknown): value is VideoRating {
  return value === null || (typeof value === "number" && VIDEO_RATING_OPTIONS.some((o) => o.value === value));
}

export function ratingToAges(rating: VideoRating): Record<string, number> | null {
  return rating === null ? null : { ANY: rating };
}

export function agesToRating(ages: Record<string, number> | null | undefined): VideoRating {
  const any = ages?.ANY;
  return typeof any === "number" ? any : null;
}

export type SetRatingResult = { ok: true } | { ok: false; reason: "not_found" | "not_video" };

/**
 * Sets a video library's rating and rewrites every title in it, atomically. The library row is
 * locked FOR UPDATE first: a scan writing titles at the same moment holds it FOR SHARE (see
 * syncVideoDirectory), so it either finishes before this runs (its rows get rewritten here) or
 * waits and then writes the new rating. Neither can leave a title with the old, looser one.
 */
export async function setVideoLibraryRating(ex: Db, libraryId: string, rating: VideoRating): Promise<SetRatingResult> {
  return ex.transaction(async (tx): Promise<SetRatingResult> => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    const [library] = await tx.select({ kind: libraries.kind }).from(libraries).where(eq(libraries.id, libraryId)).for("update");
    if (!library) return { ok: false, reason: "not_found" };
    if (library.kind !== "video") return { ok: false, reason: "not_video" };
    const ages = ratingToAges(rating);
    await tx.update(libraries).set({ ratingAges: ages }).where(eq(libraries.id, libraryId));
    await tx.update(titles).set({ ratingAges: ages }).where(eq(titles.libraryId, libraryId));
    return { ok: true };
  });
}
