import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { searchMovies, searchTvShows, tmdbImageUrl } from "@/lib/tmdb/client";
import { yearOf } from "@/lib/tmdb/match";
import { listWishes, onServerFor } from "@/lib/wishlist/service";
import { wishActor } from "@/lib/wishlist/http";

export interface WishSearchHit {
  tmdbId: number;
  kind: "movie" | "show";
  title: string;
  year: number | null;
  posterUrl: string | null;
  overview: string | null;
  /** Already on this server (that this profile may see). */
  titleId: string | null;
  /** Already on the wishlist. */
  wishId: string | null;
}

/** Looks up a movie or TV show on TMDB for the wishlist: `?q=name&kind=movie|show`. Marks those already on the server or already wished for. */
export async function GET(request: Request, ctx: RouteContext<"/api/servers/[serverId]/wishlist/search">) {
  const { serverId } = await ctx.params;
  const r = await wishActor(serverId);
  if ("response" in r) return r.response;
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind");
  const q = (params.get("q") ?? "").trim().slice(0, 100);
  if ((kind !== "movie" && kind !== "show") || q.length < 2) return NextResponse.json({ results: [] });
  if (!(await checkRateLimit(r.who.accountId, "wishlist-search", 60, 600))) return NextResponse.json({ error: "Too many requests — slow down a little." }, { status: 429 });
  let hits: WishSearchHit[];
  try {
    const found = kind === "movie" ? (await searchMovies(q)).map((m) => ({ id: m.id, title: m.title, date: m.release_date, poster: m.poster_path, overview: m.overview })) : (await searchTvShows(q)).map((t) => ({ id: t.id, title: t.name, date: t.first_air_date, poster: t.poster_path, overview: t.overview }));
    hits = found.slice(0, 8).map((f) => ({ tmdbId: f.id, kind, title: f.title, year: yearOf(f.date) ?? null, posterUrl: tmdbImageUrl(f.poster, "w342"), overview: f.overview?.slice(0, 400) || null, titleId: null, wishId: null }));
  } catch {
    return NextResponse.json({ error: "The movie and TV database couldn't be reached. Try again in a moment." }, { status: 502 });
  }
  // Which are already here or already wished for: the same view the list itself shows.
  const wishes = await listWishes(db, { serverId, actor: r.who.actor, viewer: r.who.viewer, accountId: r.who.accountId, isAdmin: r.who.isAdmin });
  const here = await onServerFor(db, { serverId, actor: r.who.actor, viewer: r.who.viewer }, hits.map((h) => ({ kind: h.kind, tmdbId: h.tmdbId })));
  for (const h of hits) {
    const wish = wishes.find((w) => w.kind === h.kind && w.tmdbId === h.tmdbId);
    h.wishId = wish && wish.status !== "got" ? wish.id : null;
    h.titleId = here.get(`${h.kind}:${h.tmdbId}`) ?? null;
  }
  return NextResponse.json({ results: hits });
}
