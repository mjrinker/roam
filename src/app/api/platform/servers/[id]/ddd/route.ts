import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { servers } from "@/lib/db/schema";
import { getPlatformAdmin } from "@/lib/platform/guard";

const bodySchema = z.object({ access: z.enum(["disabled", "limited", "full"]) }).strict();

/** Platform admin: how much of Does the Dog Die (through the deployment's key) a server may use. Server admins can't change it. */
export async function PUT(request: Request, ctx: RouteContext<"/api/platform/servers/[id]/ddd">) {
  if (!(await getPlatformAdmin())) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose off, limited or full." }, { status: 400 });
  const rows = await db.update(servers).set({ dddAccess: parsed.data.access }).where(eq(servers.id, id)).returning({ id: servers.id });
  if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, access: parsed.data.access });
}
