import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { AUDIBLE_REGIONS } from "@/lib/audible/client";

const bodySchema = z.object({
  audibleRegion: z.enum(Object.keys(AUDIBLE_REGIONS) as [string, ...string[]]),
});

/** Admin: change a library's settings (currently just the Audible storefront used to match audiobooks). */
export async function PATCH(request: Request, ctx: RouteContext<"/api/libraries/[id]">) {
  const { id } = await ctx.params;

  const serverId = await resolveServerIdForLibrary(id);
  if (!serverId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admin = await getCurrentServerAdmin(serverId);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid region" }, { status: 400 });

  await db.update(libraries).set({ audibleRegion: parsed.data.audibleRegion }).where(eq(libraries.id, id));
  return NextResponse.json({ ok: true });
}
