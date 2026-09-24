import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentAdminProfile } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { titles } from "@/lib/db/schema";
import { getMovieDetails, getTvShowDetails, tmdbImageUrl } from "@/lib/tmdb/client";
import { refreshShowEpisodesFromTmdb } from "@/lib/scan/scanner";

const bodySchema = z.object({ tmdbId: z.number().int().positive() });

/** Admin picks a corrected TMDB match for a title the auto-matcher got wrong (or missed). */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/titles/[id]/match">
) {
  const admin = await getCurrentAdminProfile();
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const [title] = await db.select().from(titles).where(eq(titles.id, id)).limit(1);
  if (!title) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (title.kind === "movie") {
    const details = await getMovieDetails(parsed.data.tmdbId);
    await db
      .update(titles)
      .set({
        tmdbId: details.id,
        overview: details.overview ?? null,
        posterUrl: tmdbImageUrl(details.poster_path, "w500"),
        backdropUrl: tmdbImageUrl(details.backdrop_path, "w1280"),
        genres: details.genres?.map((g) => g.name) ?? [],
        metadataStatus: "manual",
        updatedAt: new Date(),
      })
      .where(eq(titles.id, id));
  } else {
    const details = await getTvShowDetails(parsed.data.tmdbId);
    await db
      .update(titles)
      .set({
        tmdbId: details.id,
        overview: details.overview ?? null,
        posterUrl: tmdbImageUrl(details.poster_path, "w500"),
        backdropUrl: tmdbImageUrl(details.backdrop_path, "w1280"),
        genres: details.genres?.map((g) => g.name) ?? [],
        metadataStatus: "manual",
        updatedAt: new Date(),
      })
      .where(eq(titles.id, id));
    await refreshShowEpisodesFromTmdb(id, details.id);
  }

  return NextResponse.json({ ok: true });
}
