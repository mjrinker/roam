import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { hashBatch } from "@/lib/photos/dedupe/service";
import { photoLibraryAdmin } from "@/lib/photos/dedupe/http";
import { checkRateLimit } from "@/lib/rate-limit";

export const maxDuration = 60;

/** Looks at the next batch of pictures that have not been checked yet (the page calls this again and again until none are left). */
export async function POST(_request: Request, ctx: RouteContext<"/api/libraries/[id]/duplicates/hash">) {
  const { id } = await ctx.params;
  const lib = await photoLibraryAdmin(id);
  if ("response" in lib) return lib.response;
  if (!(await checkRateLimit(lib.accountId, "photo-dedupe-hash", 120, 600))) return NextResponse.json({ error: "Too many requests — try again in a minute." }, { status: 429 });
  const result = await hashBatch(db, { libraryId: lib.libraryId, limit: 40, deadlineMs: Date.now() + 40_000 });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
