/** Shared plumbing for the duplicate-photo routes: only the admin of the server a photo library belongs to. */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/** The photo library, if it exists and the signed-in profile is the admin of its server (a profile that may change settings); otherwise the one 404/403. */
export async function photoLibraryAdmin(libraryId: string): Promise<{ libraryId: string; serverId: string; accountId: string } | { response: NextResponse }> {
  if (!UUID.test(libraryId)) return { response: notFound() };
  const [lib] = await db.select({ id: libraries.id, serverId: libraries.serverId, kind: libraries.kind }).from(libraries).where(eq(libraries.id, libraryId));
  if (!lib || !isPhotoLibraryKind(lib.kind)) return { response: notFound() };
  const admin = await getCurrentServerAdmin(lib.serverId);
  if (!admin) return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { libraryId: lib.id, serverId: lib.serverId, accountId: admin.profile.id };
}
