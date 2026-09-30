import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForTitle } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { titles } from "@/lib/db/schema";
import { getMovieDetails, getTvShowDetails, tmdbImageUrl } from "@/lib/tmdb/client";
import { ratingsFromMovieDetails, ratingsFromTvDetails } from "@/lib/content/ratings";
import { refreshShowEpisodesFromTmdb } from "@/lib/scan/scanner";
import { stampTmdbIdOnBox } from "@/lib/scan/tag-rename";

const bodySchema = z.object({ tmdbId: z.number().int().positive() });

/** Admin picks a corrected TMDB match for a title the auto-matcher got wrong (or missed). */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/titles/[id]/match">
) {
  const { id } = await ctx.params;

  const serverId = await resolveServerIdForTitle(id);
  if (!serverId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const admin = await getCurrentServerAdmin(serverId);
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const [title] = await db.select().from(titles).where(eq(titles.id, id)).limit(1);
  if (!title) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (title.kind === "audiobook") {
    return NextResponse.json({ error: "Audiobooks are matched against Audible, not TMDB." }, { status: 400 });
  }

  if (title.kind === "movie") {
    const details = await getMovieDetails(parsed.data.tmdbId, { append: ["release_dates"] });
    const { certifications, ratingAges } = ratingsFromMovieDetails(details);
    const imdbId = details.imdb_id ?? null;
    await db
      .update(titles)
      .set({
        tmdbId: details.id,
        overview: details.overview ?? null,
        posterUrl: tmdbImageUrl(details.poster_path, "w500"),
        backdropUrl: tmdbImageUrl(details.backdrop_path, "w1280"),
        genres: details.genres?.map((g) => g.name) ?? [],
        metadataStatus: "manual",
        certifications,
        ratingAges,
        ratingsAttemptedAt: new Date(),
        imdbId,
        // A new match means any previously-fetched OMDb data belongs to the
        // wrong film; clear it and let the backfill re-fetch for the new id.
        ...(imdbId !== title.imdbId
          ? { imdbRating: null, imdbVotes: null, rottenTomatoesScore: null, metascore: null, externalRatingsAttemptedAt: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(titles.id, id));
  } else {
    const details = await getTvShowDetails(parsed.data.tmdbId, { append: ["content_ratings", "external_ids"] });
    const { certifications, ratingAges } = ratingsFromTvDetails(details);
    const imdbId = details.external_ids?.imdb_id ?? null;
    await db
      .update(titles)
      .set({
        tmdbId: details.id,
        overview: details.overview ?? null,
        posterUrl: tmdbImageUrl(details.poster_path, "w500"),
        backdropUrl: tmdbImageUrl(details.backdrop_path, "w1280"),
        genres: details.genres?.map((g) => g.name) ?? [],
        metadataStatus: "manual",
        certifications,
        ratingAges,
        ratingsAttemptedAt: new Date(),
        imdbId,
        ...(imdbId !== title.imdbId
          ? { imdbRating: null, imdbVotes: null, rottenTomatoesScore: null, metascore: null, externalRatingsAttemptedAt: null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(titles.id, id));
    await refreshShowEpisodesFromTmdb(id, details.id);
  }

  // Failing to rename (Box permissions, a name clash) doesn't undo the match;
  // it just means a rescan won't be pinned to it by the folder name.
  const { errors: renameErrors } = await stampTmdbIdOnBox(
    serverId,
    { kind: title.kind, boxFolderId: title.boxFolderId },
    parsed.data.tmdbId
  ).catch((err) => ({ errors: [(err as Error).message] }));

  return NextResponse.json({ ok: true, renameErrors });
}
