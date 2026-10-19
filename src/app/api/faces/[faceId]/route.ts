import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { changeFace, faceTitleId, type FaceChange } from "@/lib/faces/service";
import { checkRateLimit } from "@/lib/rate-limit";

const headers = { "Cache-Control": "no-store" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers });

const bodySchema = z.union([
  z.object({ person: z.string().uuid() }).strict(),
  z.object({ person: z.null() }).strict(),
  z.object({ newPerson: z.string().min(1).max(200) }).strict(),
  z.object({ confirm: z.literal(true) }).strict(),
  z.object({ ignore: z.literal(true) }).strict(),
]);

/**
 * An admin's decision about one face: `{ person: id }` or `{ newPerson: "Name" }` to name it, `{ confirm: true }` to accept the suggested
 * name, `{ person: null }` to take the name off, `{ ignore: true }` to dismiss it as not a face. Everyone else gets a plain not-found.
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/faces/[faceId]">) {
  const { faceId } = await ctx.params;
  if (!z.string().uuid().safeParse(faceId).success) return notFound();
  const titleId = await faceTitleId(db, faceId);
  if (!titleId) return notFound();
  const auth = await authorizeOwner("title", titleId, { titleKinds: ["photo"] });
  if (!auth.ok) return notFound();
  if (!(await getCurrentServerAdmin(auth.serverId))) return notFound();
  if (!(await checkRateLimit(auth.member.profile.id, "face_change", 240, 60))) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Say who this is, or dismiss it." }, { status: 400, headers });
  const result = await changeFace(db, auth.serverId, faceId, body.data as FaceChange);
  if (!result.ok) return NextResponse.json({ error: "That can't be done to this face." }, { status: 409, headers });
  return NextResponse.json({ personId: result.personId }, { headers });
}
