import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { facesOfPhoto, peopleOfServer } from "@/lib/faces/service";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";
import { checkRateLimit } from "@/lib/rate-limit";

const headers = { "Cache-Control": "private, no-store" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers });

/**
 * The faces found in a picture and who they are (see lib/faces): `{ faces: [{ id, x, y, w, h, person, suggestion }], canEdit, people }`, where
 * `people` (the server's named people, for the picker) is only sent to the server's admin, who alone can name faces. Same gate as the picture.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/photos/[id]/faces">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const auth = await authorizeOwner("title", id, { titleKinds: ["photo"] });
  if (!auth.ok || !isPhotoLibraryKind(auth.libraryKind)) return notFound();
  if (!(await checkRateLimit(auth.member.profile.id, "photo_faces", 240, 60))) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
  const admin = await getCurrentServerAdmin(auth.serverId);
  const faces = await facesOfPhoto(db, id);
  return NextResponse.json({ faces, canEdit: !!admin, ...(admin ? { people: await peopleOfServer(db, auth.serverId) } : {}) }, { headers });
}
