import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { deleteServer } from "@/lib/auth/delete-server";
import { db } from "@/lib/db/client";
import { servers } from "@/lib/db/schema";
import { isUuid } from "@/lib/playlists/http";

const bodySchema = z.object({ name: z.string() });

/**
 * Admin: delete the server. The body must repeat its name, so a stray request can't remove one. Its libraries, everyone's place on it,
 * invitations, playlists and storage sign-ins go; the files in storage are not touched.
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/servers/[serverId]">) {
  const { serverId } = await ctx.params;
  if (!isUuid(serverId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await getCurrentServerAdmin(serverId))) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [server] = await db.select({ name: servers.name }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.name !== server.name) return NextResponse.json({ error: "Type the server's name to confirm." }, { status: 400 });

  const result = await deleteServer(serverId);
  return NextResponse.json({ ok: true, libraries: result.libraries });
}
