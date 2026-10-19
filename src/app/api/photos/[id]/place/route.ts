import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";
import { checkRateLimit } from "@/lib/rate-limit";
import { parsePlace, setPhotoPlace } from "@/lib/photos/set-taken-at";

export const maxDuration = 60;

const headers = { "Cache-Control": "no-store" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers });

/**
 * Sets where a picture was taken (see lib/photos/set-taken-at): `{ place: { latitude, longitude, name } }`, or `{ place: null }` to remove it.
 * Admin only; everyone else gets the same not-found as for a picture that doesn't exist. Answers `{ place, file }` like the date route.
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/photos/[id]/place">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const auth = await authorizeOwner("title", id, { titleKinds: ["photo"] });
  if (!auth.ok || !isPhotoLibraryKind(auth.libraryKind)) return notFound();
  if (!(await getCurrentServerAdmin(auth.serverId))) return notFound();
  if (!(await checkRateLimit(auth.member.profile.id, "photo_place", 60, 60))) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
  const body = (await request.json().catch(() => null)) as { place?: unknown } | null;
  const place = body && "place" in body ? parsePlace(body.place) : undefined;
  if (place === undefined) return NextResponse.json({ error: "Send a place with a latitude and longitude, or null to remove it." }, { status: 400, headers });
  const result = await setPhotoPlace(auth.serverId, id, place);
  if (!result) return notFound();
  return NextResponse.json(result, { headers });
}
