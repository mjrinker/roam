import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { libraries } from "@/lib/db/schema";
import { isFileTreeLibraryKind } from "@/lib/libraries/profile";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * Admin only: turn "remove videos that left Box" on or off for a video library. Everyone else (and
 * unknown or malformed ids) gets the same 404, so this never confirms a library exists.
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/libraries/[id]/prune">) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  const serverId = await resolveServerIdForLibrary(id);
  if (!serverId || !(await getCurrentServerAdmin(serverId))) return notFound();

  const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
  if (!body || typeof body.enabled !== "boolean") return NextResponse.json({ error: "Send enabled: true or false." }, { status: 400 });

  const [library] = await db.select({ kind: libraries.kind }).from(libraries).where(eq(libraries.id, id));
  if (!library) return notFound();
  if (!isFileTreeLibraryKind(library.kind)) return NextResponse.json({ error: "Only video and audio libraries have this setting." }, { status: 400 });
  await db.update(libraries).set({ pruneMissing: body.enabled }).where(eq(libraries.id, id));
  return NextResponse.json({ ok: true });
}
