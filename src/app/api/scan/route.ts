import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { getCurrentAdminProfile } from "@/lib/auth/guards";
import { scanLibrary } from "@/lib/scan/scanner";

const bodySchema = z.object({ libraryId: z.string().uuid().optional() });

/** Admin-triggered manual rescan of one library, or all libraries if omitted. */
export async function POST(request: Request) {
  const profile = await getCurrentAdminProfile();
  if (!profile) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const targets = parsed.data.libraryId
    ? [{ id: parsed.data.libraryId }]
    : await db.select({ id: libraries.id }).from(libraries);

  const results = [];
  for (const lib of targets) {
    results.push(await scanLibrary(lib.id, "manual"));
  }

  return NextResponse.json({ results });
}
