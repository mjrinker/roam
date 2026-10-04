import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { titleArtwork } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png"]);

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * A title's artwork (an embedded cover, or a thumbnail Box made), for video libraries. It goes through
 * the same gate as playing the title: library access and the profile's age limit. EVERY failure is the
 * same 404 (no such title, not a member, hidden library, too-strict age limit, no image), so this never
 * confirms that something exists. Responses are private to the signed-in browser: the URL carries no
 * credentials and must never be stored by a shared cache.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/titles/[id]/artwork">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();

  const auth = await authorizeOwner("title", id);
  if (!auth.ok) return notFound();
  if (!(await checkRateLimit(auth.member.profile.id, "title_artwork", 1200, 60))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const [art] = await db
    .select({ contentType: titleArtwork.contentType, bytes: titleArtwork.bytes, updatedAt: titleArtwork.updatedAt })
    .from(titleArtwork)
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
