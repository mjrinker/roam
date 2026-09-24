import { NextResponse } from "next/server";
import { getCurrentAdminProfile } from "@/lib/auth/guards";
import { searchMovies, searchTvShows, tmdbImageUrl } from "@/lib/tmdb/client";

export interface TmdbSearchResultDto {
  tmdbId: number;
  name: string;
  year: number | null;
  posterUrl: string | null;
}

/** Admin-only search proxy — keeps the TMDB token server-side. */
export async function GET(request: Request) {
  const admin = await getCurrentAdminProfile();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
