/**
 * The age rating of a video ("generic") library. Videos carry no rating of their own, so the admin
 * rates the whole library. It is stored on the library and COPIED onto every title in it as
 * `{ ANY: minimumAge }` (the catch-all key lib/content/access already understands), so the existing
 * age filter works unchanged. null = unrated: each profile's "allow unrated" setting decides.
 */
import { eq, sql } from "drizzle-orm";
import { libraries, titles } from "@/lib/db/schema";
import { isFileTreeLibraryKind } from "@/lib/libraries/profile";
import type { Db } from "@/lib/scan/media-files";

export { agesToRating, isVideoRating, ratingToAges, VIDEO_RATING_OPTIONS, type VideoRating } from "@/lib/libraries/video-rating-options";
import { ratingToAges, type VideoRating } from "@/lib/libraries/video-rating-options";

export type SetRatingResult = { ok: true } | { ok: false; reason: "not_found" | "unsupported_kind" };

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
    if (!isFileTreeLibraryKind(library.kind)) return { ok: false, reason: "unsupported_kind" };
    const ages = ratingToAges(rating);
    await tx.update(libraries).set({ ratingAges: ages }).where(eq(libraries.id, libraryId));
    await tx.update(titles).set({ ratingAges: ages }).where(eq(titles.libraryId, libraryId));
    return { ok: true };
  });
}
