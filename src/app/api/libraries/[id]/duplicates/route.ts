import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { DISTANCES, duplicateGroups, hashProgress, hiddenDuplicates } from "@/lib/photos/dedupe/service";
import { photoLibraryAdmin } from "@/lib/photos/dedupe/http";

/**
 * The duplicate photos of a photo library, for its server's admin: `?match=exact|similar|loose` (default similar) gives the groups of pictures that
 * look alike, how many pictures have been checked so far, and the copies already hidden.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/libraries/[id]/duplicates">) {
  const { id } = await ctx.params;
  const lib = await photoLibraryAdmin(id);
  if ("response" in lib) return lib.response;
  const match = new URL(request.url).searchParams.get("match");
  const maxDistance = match === "exact" ? DISTANCES.exact : match === "loose" ? DISTANCES.loose : DISTANCES.similar;
  const [groups, progress, hidden] = await Promise.all([duplicateGroups(db, { libraryId: lib.libraryId, maxDistance }), hashProgress(db, lib.libraryId), hiddenDuplicates(db, lib.libraryId)]);
  return NextResponse.json({ groups, progress, hidden }, { headers: { "Cache-Control": "no-store" } });
}
