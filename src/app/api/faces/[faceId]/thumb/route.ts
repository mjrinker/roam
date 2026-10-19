import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { faceThumb, faceTitleId } from "@/lib/faces/service";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";
import { checkRateLimit } from "@/lib/rate-limit";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

/** A face's small square picture. Same gate as the picture it was cut from; a face's picture never changes, so it caches for a day. */
export async function GET(_request: Request, ctx: RouteContext<"/api/faces/[faceId]/thumb">) {
  const { faceId } = await ctx.params;
  if (!z.string().uuid().safeParse(faceId).success) return notFound();
  const titleId = await faceTitleId(db, faceId);
  if (!titleId) return notFound();
  const auth = await authorizeOwner("title", titleId, { titleKinds: ["photo"] });
  if (!auth.ok || !isPhotoLibraryKind(auth.libraryKind)) return notFound();
  if (!(await checkRateLimit(auth.member.profile.id, "face_thumb", 1200, 60))) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Cache-Control": "no-store" } });
  const thumb = await faceThumb(db, faceId);
  if (!thumb) return notFound();
  return new Response(new Uint8Array(thumb), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
}
