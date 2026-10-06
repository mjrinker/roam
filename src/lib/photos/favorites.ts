/**
 * Hearting photos and videos. A favorite belongs to a VIEWER (profile). Setting one is only allowed on an
 * item the viewer could open right now (a photo library they can see, within their age limit); the favorites
 * view reuses the timeline's visibility rules, so a favorite that later becomes hidden just stops showing.
 */
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { photoFavorites } from "@/lib/db/schema";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";
import { checkRateLimit } from "@/lib/rate-limit";

const headers = { "Cache-Control": "no-store" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers });

/** PUT hearts, DELETE un-hearts. Idempotent, and every failure to be allowed is the same 404. */
export async function setFavorite(id: string, favorite: boolean): Promise<Response> {
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const auth = await authorizeOwner("title", id, { titleKinds: ["photo", "movie"] });
  if (!auth.ok || !isPhotoLibraryKind(auth.libraryKind)) return notFound();
  // A cheap bucket of its own: hearts must not spend the budget thumbnails and previews depend on.
  if (!(await checkRateLimit(auth.member.profile.id, "photo_favorite", 120, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { ...headers, "Retry-After": "10" } });
  }
  const viewerId = auth.member.viewer.id;
  if (favorite) {
    await db.insert(photoFavorites).values({ viewerId, titleId: id }).onConflictDoNothing();
  } else {
    await db.delete(photoFavorites).where(and(eq(photoFavorites.viewerId, viewerId), eq(photoFavorites.titleId, id)));
  }
  return NextResponse.json({ favorite }, { headers });
}
