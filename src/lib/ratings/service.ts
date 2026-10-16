/** A profile's own star ratings: checks the caller may see the thing (the same gate as playing or marking it), then keeps the rating. */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, musicAlbums, ratings } from "@/lib/db/schema";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { canSeeLibrary, libraryActor } from "@/lib/content/library-access";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
export type RatingKind = "title" | "episode" | "album";
export type RateResult = { ok: true } | { ok: false; status: 403 | 404 };

/** Rates (`halfStars` 1 to 10) or, with null, clears the rating. A picture or clip in a photo library can't be rated; anything unseen is "not found". */
export async function setRating(args: { kind: RatingKind; id: string; halfStars: number | null }): Promise<RateResult> {
  let viewerId: string;
  if (args.kind === "album") {
    const [album] = await db.select({ serverId: libraries.serverId, libraryId: libraries.id }).from(musicAlbums).innerJoin(libraries, eq(libraries.id, musicAlbums.libraryId)).where(eq(musicAlbums.id, args.id)).limit(1);
    if (!album) return { ok: false, status: 404 };
    const member = await getCurrentServerMember(album.serverId);
    if (!member) return { ok: false, status: 404 };
    if (!(await canSeeLibrary(db, libraryActor(member, album.serverId), album.libraryId))) return { ok: false, status: 404 };
    viewerId = member.viewer.id;
  } else {
    const auth = args.kind === "episode" ? await authorizeOwner("episode", args.id) : await authorizeOwner("title", args.id, { titleKinds: ["movie", "show", "audiobook", "ebook"] });
    if (!auth.ok) return { ok: false, status: auth.status === 403 ? 403 : 404 };
    viewerId = auth.member.viewer.id;
  }
  if (args.halfStars === null) {
    await db.delete(ratings).where(and(eq(ratings.viewerId, viewerId), eq(ratings.ownerKind, args.kind), eq(ratings.ownerId, args.id)));
  } else {
    await db
      .insert(ratings)
      .values({ viewerId, ownerKind: args.kind, ownerId: args.id, halfStars: args.halfStars })
      .onConflictDoUpdate({ target: [ratings.viewerId, ratings.ownerKind, ratings.ownerId], set: { halfStars: args.halfStars, updatedAt: new Date() } });
  }
  return { ok: true };
}

/** This profile's ratings of the given things, by id. */
export async function ratingsOf(ex: Db, viewerId: string, kind: RatingKind, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await ex.select({ id: ratings.ownerId, half: ratings.halfStars }).from(ratings).where(and(eq(ratings.viewerId, viewerId), eq(ratings.ownerKind, kind), inArray(ratings.ownerId, ids)));
  return new Map(rows.map((r) => [r.id, r.half]));
}
