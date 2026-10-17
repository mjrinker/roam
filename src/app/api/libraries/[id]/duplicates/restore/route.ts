import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { restoreDuplicates } from "@/lib/photos/dedupe/service";
import { photoLibraryAdmin } from "@/lib/photos/dedupe/http";

const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).strict();

/** Brings hidden copies back into the timeline. */
export async function POST(request: Request, ctx: RouteContext<"/api/libraries/[id]/duplicates/restore">) {
  const { id } = await ctx.params;
  const lib = await photoLibraryAdmin(id);
  if ("response" in lib) return lib.response;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  return NextResponse.json({ restored: await restoreDuplicates(db, { libraryId: lib.libraryId, ids: parsed.data.ids }) });
}
