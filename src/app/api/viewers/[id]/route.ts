import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getCurrentProfile } from "@/lib/auth/guards";
import { getCurrentViewer } from "@/lib/auth/viewer";
import { db } from "@/lib/db/client";
import { viewers } from "@/lib/db/schema";
import { MULTIPLE_VIEWERS_ENABLED } from "@/lib/viewers/config";
import { VIEWER_COOKIE } from "@/lib/viewers/cookie";
import { updateViewerSchema } from "@/lib/viewers/validation";

/** Edit one of the signed-in account's profiles. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/viewers/[id]">) {
  const { id } = await ctx.params;
  const account = await getCurrentProfile();
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = updateViewerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid profile" }, { status: 400 });
  }

  const updated = await db
    .update(viewers)
    .set(parsed.data)
    .where(and(eq(viewers.id, id), eq(viewers.accountId, account.id)))
    .returning({ id: viewers.id });
  if (updated.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** Delete one of the signed-in account's profiles (never the last one). */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/viewers/[id]">) {
  const { id } = await ctx.params;
  const account = await getCurrentProfile();
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!MULTIPLE_VIEWERS_ENABLED) {
    return NextResponse.json({ error: "Deleting profiles isn't available yet." }, { status: 403 });
  }

  const deleted = await db.transaction(async (tx) => {
    const mine = await tx.select({ id: viewers.id }).from(viewers).where(eq(viewers.accountId, account.id)).for("update");
    if (!mine.some((v) => v.id === id)) return "not_found" as const;
    if (mine.length <= 1) return "last" as const;
    await tx.delete(viewers).where(eq(viewers.id, id));
    return "ok" as const;
  });

  if (deleted === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (deleted === "last") return NextResponse.json({ error: "An account needs at least one profile." }, { status: 400 });

  // Deleting the profile that's currently selected sends the device back to the chooser.
  const current = await getCurrentViewer();
  if (current?.viewer?.id === id) (await cookies()).delete(VIEWER_COOKIE);
  return NextResponse.json({ ok: true });
}
