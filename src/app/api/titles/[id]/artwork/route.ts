import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { PLAYABLE_TITLE_KINDS } from "@/lib/libraries/profile";
import { db } from "@/lib/db/client";
import { artworkImages, titleArtwork } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png"]);

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * A title's artwork (an embedded cover, or a thumbnail Box made), for video and audio libraries. It goes through
 * the same gate as playing the title: library access and the profile's age limit. EVERY failure is the
 * same 404 (no such title, not a member, hidden library, too-strict age limit, no image), so this never
 * confirms that something exists. Responses are private to the signed-in browser: the URL carries no
 * credentials and must never be stored by a shared cache.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/titles/[id]/artwork">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();

  // A book is not something that plays, but it has a cover like the rest.
  const auth = await authorizeOwner("title", id, { titleKinds: [...PLAYABLE_TITLE_KINDS, "ebook"] });
  if (!auth.ok) return notFound();
  if (!(await checkRateLimit(auth.member.profile.id, "title_artwork", 1200, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const [art] = await db
    .select({ contentType: artworkImages.contentType, bytes: artworkImages.bytes, updatedAt: titleArtwork.updatedAt })
    .from(titleArtwork)
    .innerJoin(artworkImages, eq(artworkImages.hash, titleArtwork.imageHash))
    .where(eq(titleArtwork.titleId, id))
    .limit(1);
  if (!art || !ALLOWED_TYPES.has(art.contentType)) return notFound();

  const bytes = new Uint8Array(art.bytes);
  const etag = `"${art.updatedAt.getTime()}-${bytes.length}"`;
  const headers = {
    "Cache-Control": "private, max-age=300, must-revalidate",
    Vary: "Cookie",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(bytes, { headers: { ...headers, "Content-Type": art.contentType, "Content-Length": String(bytes.length) } });
}
