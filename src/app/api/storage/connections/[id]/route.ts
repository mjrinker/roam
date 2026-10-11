import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { storageConnections } from "@/lib/db/schema";
import { connectionUse } from "@/lib/storage/connections";

async function adminOf(id: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [conn] = await db.select({ id: storageConnections.id, serverId: storageConnections.serverId }).from(storageConnections).where(eq(storageConnections.id, id)).limit(1);
  if (!conn) return null;
  return (await getCurrentServerAdmin(conn.serverId)) ? conn : null;
}

const renameSchema = z.object({ label: z.string().trim().min(1).max(60) });

/** Admin: rename a connection. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/storage/connections/[id]">) {
  const { id } = await ctx.params;
  const conn = await adminOf(id);
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = renameSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Give it a name of 1 to 60 characters." }, { status: 400 });
  await db.update(storageConnections).set({ label: parsed.data.label }).where(eq(storageConnections.id, id));
  return NextResponse.json({ ok: true });
}

/** Admin: remove a connection - only when no library has a folder on it (remove those first). */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/storage/connections/[id]">) {
  const { id } = await ctx.params;
  const conn = await adminOf(id);
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const using = (await connectionUse(conn.serverId)).get(id)?.size ?? 0;
  if (using > 0) {
    return NextResponse.json({ error: `${using === 1 ? "A library has" : `${using} libraries have`} a folder on this connection. Remove ${using === 1 ? "it" : "them"} from the library first.` }, { status: 409 });
  }
  await db.delete(storageConnections).where(and(eq(storageConnections.id, id), eq(storageConnections.serverId, conn.serverId)));
  return NextResponse.json({ ok: true });
}
