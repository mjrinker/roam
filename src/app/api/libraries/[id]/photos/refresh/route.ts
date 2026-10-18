import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { canSeeLibrary, libraryActor } from "@/lib/content/library-access";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";
import { checkRateLimit } from "@/lib/rate-limit";
import { scanRecentPhotos, type RecentScanResult } from "@/lib/scan/photos-recent";

export const maxDuration = 60;

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers });

/** One look per library at a time on this server: a second ask (another tab, a quick pull) shares the first's answer. */
const running = new Map<string, Promise<RecentScanResult>>();

/**
 * Looks for pictures and videos added to a photo library since it was last scanned, from the newest forward (see lib/scan/photos-recent), so
 * opening the library or pulling down on it shows what was just added. Any member who can see the library may ask: it only brings in what is
 * already in the storage. Answers `{ added, incomplete, problems }`.
 */
export async function POST(_request: Request, ctx: RouteContext<"/api/libraries/[id]/photos/refresh">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const serverId = await resolveServerIdForLibrary(id);
  if (!serverId) return notFound();
  const member = await getCurrentServerMember(serverId);
  if (!member) return notFound();
  if (!(await canSeeLibrary(db, libraryActor(member, serverId), id))) return notFound();
  const [library] = await db.select({ kind: libraries.kind }).from(libraries).where(eq(libraries.id, id)).limit(1);
  if (!library || !isPhotoLibraryKind(library.kind)) return notFound();
  if (!(await checkRateLimit(member.profile.id, "photo_refresh", 12, 60))) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });

  let job = running.get(id);
  if (!job) {
    job = scanRecentPhotos(id).finally(() => running.delete(id));
    running.set(id, job);
  }
  try {
    const result = await job;
    return NextResponse.json({ added: result.added, incomplete: result.incomplete, problems: result.errors.length }, { headers });
  } catch {
    return NextResponse.json({ error: "Couldn't look for new photos right now." }, { status: 502, headers });
  }
}
