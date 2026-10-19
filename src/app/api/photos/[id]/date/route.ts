import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseTypedDate, setPhotoTakenAt } from "@/lib/photos/set-taken-at";

export const maxDuration = 60;

const headers = { "Cache-Control": "no-store" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers });

/**
 * Sets when a picture was taken (see lib/photos/set-taken-at): `{ takenAt: "2015-06-01T08:30" }`, a wall-clock time without a zone. Only
 * the server's admin may change a date; everyone else gets the same not-found as for a picture that doesn't exist. Answers
 * `{ takenAt, file }`, where `file` says whether the date was also written into the file ("written") or kept in Roam only (and why).
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/photos/[id]/date">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const auth = await authorizeOwner("title", id, { titleKinds: ["photo"] });
  if (!auth.ok || !isPhotoLibraryKind(auth.libraryKind)) return notFound();
  if (!(await getCurrentServerAdmin(auth.serverId))) return notFound();
  if (!(await checkRateLimit(auth.member.profile.id, "photo_date", 60, 60))) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
  const body = (await request.json().catch(() => null)) as { takenAt?: unknown } | null;
  const takenAt = parseTypedDate(body?.takenAt);
  if (!takenAt) return NextResponse.json({ error: "Send a date and time that has happened, like 2015-06-01T08:30." }, { status: 400, headers });
  const result = await setPhotoTakenAt(auth.serverId, id, takenAt);
  if (!result) return notFound();
  return NextResponse.json(result, { headers });
}
