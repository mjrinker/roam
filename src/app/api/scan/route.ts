import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { scanLibrary } from "@/lib/scan/scanner";

const bodySchema = z.object({
  serverId: z.string().uuid(),
  libraryId: z.string().uuid().optional(),
});

/** Admin-triggered manual rescan of one of the caller's server's libraries, or all of them if omitted. */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const admin = await getCurrentServerAdmin(parsed.data.serverId);
  if (!admin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let targets: { id: string }[];
  if (parsed.data.libraryId) {
    // Don't trust that the library actually belongs to this server just
    // because the caller is an admin of SOME server — verify it.
    const owningServerId = await resolveServerIdForLibrary(parsed.data.libraryId);
    if (owningServerId !== parsed.data.serverId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    targets = [{ id: parsed.data.libraryId }];
  } else {
    targets = await db
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.serverId, parsed.data.serverId));
  }

  const results = [];
  for (const lib of targets) {
    results.push(await scanLibrary(lib.id, "manual"));
  }

  return NextResponse.json({ results });
}
