import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/auth/guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { searchMovies, searchTvShows, tmdbImageUrl } from "@/lib/tmdb/client";

export interface TmdbSearchResultDto {
  tmdbId: number;
  name: string;
  year: number | null;
  posterUrl: string | null;
}

/**
 * Any signed-in profile can search — it's a read-only proxy over public
 * TMDB results, nothing tenant-private to protect, so "admin of some
 * server" isn't a meaningful check here. Rate-limited per-user since it's
 * a proxy on our own TMDB API quota and sign-up is open to anyone.
 */
export async function GET(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Guests are free to create, so a per-account limit means nothing for them: they can't spend the TMDB quota at all.
  if (profile.isGuest) return NextResponse.json({ error: "Not available to guests." }, { status: 403 });

  const withinLimit = await checkRateLimit(profile.id, "tmdb_search", 20, 60);
  if (!withinLimit) {
    return NextResponse.json({ error: "Too many searches — try again in a minute." }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();
  const kind = searchParams.get("kind");
  if (!query || (kind !== "movie" && kind !== "show")) {
    return NextResponse.json({ error: "Missing q or invalid kind" }, { status: 400 });
  }

  const results: TmdbSearchResultDto[] =
    kind === "movie"
      ? (await searchMovies(query)).map((r) => ({
          tmdbId: r.id,
          name: r.title,
          year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
          posterUrl: tmdbImageUrl(r.poster_path, "w342"),
        }))
      : (await searchTvShows(query)).map((r) => ({
          tmdbId: r.id,
          name: r.name,
          year: r.first_air_date ? Number(r.first_air_date.slice(0, 4)) : null,
          posterUrl: tmdbImageUrl(r.poster_path, "w342"),
        }));

  return NextResponse.json({ results: results.slice(0, 12) });
}
