import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { hideDuplicates } from "@/lib/photos/dedupe/service";
import { photoLibraryAdmin } from "@/lib/photos/dedupe/http";

const body = z.object({ keepId: z.string().uuid(), hideIds: z.array(z.string().uuid()).min(1).max(200) }).strict();

/** Hides copies of a photo in favour of the one kept. Nothing in the storage changes, and they can be restored. */
export async function POST(request: Request, ctx: RouteContext<"/api/libraries/[id]/duplicates/hide">) {
  const { id } = await ctx.params;
  const lib = await photoLibraryAdmin(id);
  if ("response" in lib) return lib.response;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const result = await hideDuplicates(db, { libraryId: lib.libraryId, ...parsed.data });
  return result.ok ? NextResponse.json({ hidden: result.hidden }) : NextResponse.json({ error: result.error }, { status: result.status });
}
