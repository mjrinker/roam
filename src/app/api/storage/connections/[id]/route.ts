import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { storageConnections } from "@/lib/db/schema";
import { releaseConnections } from "@/lib/platform/accounts";
import { connectionUse } from "@/lib/storage/connections";

async function adminOf(id: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [conn] = await db.select({ id: storageConnections.id, serverId: storageConnections.serverId }).from(storageConnections).where(eq(storageConnections.id, id)).limit(1);
  if (!conn) return null;
  return (await getCurrentServerAdmin(conn.serverId)) ? conn : null;
}

const patchSchema = z.union([z.object({ label: z.string().trim().min(1).max(60) }).strict(), z.object({ writeEnabled: z.boolean() }).strict()]);

/** Admin: rename a connection, or turn editing files on or off for it (on only when its sign-in has the write permission; Box is always editable). */
export async function PATCH(request: Request, ctx: RouteContext<"/api/storage/connections/[id]">) {
  const { id } = await ctx.params;
  const conn = await adminOf(id);
  if (!conn) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Give it a name of 1 to 60 characters, or say whether editing is on." }, { status: 400 });
  if ("label" in parsed.data) {
    await db.update(storageConnections).set({ label: parsed.data.label }).where(eq(storageConnections.id, id));
    return NextResponse.json({ ok: true });
  }
  const [row] = await db.select({ provider: storageConnections.provider, granted: storageConnections.writeGranted }).from(storageConnections).where(eq(storageConnections.id, id)).limit(1);
  if (!row || row.provider === "box") return NextResponse.json({ error: "Box can always be edited." }, { status: 400 });
  // Turning it on needs the provider's permission, which only signing in again with it can give.
  if (parsed.data.writeEnabled && !row.granted) return NextResponse.json({ error: "Sign in again and approve the permission to change files first." }, { status: 409 });
  await db.update(storageConnections).set({ writeEnabled: parsed.data.writeEnabled }).where(eq(storageConnections.id, id));
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
  // Unlink the outside account first (when this was its last connection), so it stops counting against the provider's app limits.
  await releaseConnections([id]);
  await db.delete(storageConnections).where(and(eq(storageConnections.id, id), eq(storageConnections.serverId, conn.serverId)));
  return NextResponse.json({ ok: true });
}
