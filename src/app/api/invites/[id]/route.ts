import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { invites } from "@/lib/db/schema";
import { isUuid } from "@/lib/playlists/http";

/**
 * Admin: delete an invitation. A pending one stops working (its link no longer joins anyone); an accepted one is only removed from the
 * list, and the person it brought in stays a member. Someone who isn't this server's admin is told it doesn't exist.
 */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/invites/[id]">) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [invite] = await db.select({ serverId: invites.serverId }).from(invites).where(eq(invites.id, id)).limit(1);
  if (!invite || !(await getCurrentServerAdmin(invite.serverId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await db.delete(invites).where(eq(invites.id, id));
  return NextResponse.json({ ok: true });
}
