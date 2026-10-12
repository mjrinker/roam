import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { deleteLibrary } from "@/lib/libraries/delete";
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

const deleteSchema = z.object({ name: z.string() });

/**
 * Admin: remove a library from Roam. The body must repeat the library's name, so a stray request can't remove one. Its items, their
 * watch history and playlist spots go; the files in storage are not touched.
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/libraries/[id]">) {
  const { id } = await ctx.params;
  const serverId = await resolveServerIdForLibrary(id);
  if (!serverId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admin = await getCurrentServerAdmin(serverId);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  const [library] = await db.select({ name: libraries.name }).from(libraries).where(eq(libraries.id, id)).limit(1);
  if (!library) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!parsed.success || parsed.data.name !== library.name) {
    return NextResponse.json({ error: "Type the library's name to confirm." }, { status: 400 });
  }
  const result = await deleteLibrary(id);
  return NextResponse.json({ ok: true, removed: result.titles });
}
