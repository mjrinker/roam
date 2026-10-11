import { NextResponse } from "next/server";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { resolveServerIdForLibrary } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { librarySources } from "@/lib/db/schema";
import { whyFolderUnusable } from "@/lib/storage/folder-check";

const bodySchema = z.object({ folderId: z.string().min(1).max(1000), label: z.string().trim().min(1).max(200) });

/** Admin: add another folder (on any of the server's connections) to a library; scans then treat the folders as one library. */
export async function POST(request: Request, ctx: RouteContext<"/api/libraries/[id]/sources">) {
  const { id } = await ctx.params;
  const serverId = await resolveServerIdForLibrary(id);
  if (!serverId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await getCurrentServerAdmin(serverId))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose a folder." }, { status: 400 });

  const problem = await whyFolderUnusable(serverId, parsed.data.folderId);
  if (problem) return NextResponse.json({ error: problem }, { status: 409 });

  const [last] = await db.select({ position: librarySources.position }).from(librarySources).where(eq(librarySources.libraryId, id)).orderBy(desc(librarySources.position)).limit(1);
  const [source] = await db
    .insert(librarySources)
    .values({ libraryId: id, rootId: parsed.data.folderId, label: parsed.data.label, position: (last?.position ?? 0) + 1 })
    .returning({ id: librarySources.id, label: librarySources.label, rootId: librarySources.rootId });
  return NextResponse.json({ source });
}
