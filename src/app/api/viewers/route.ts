import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getCurrentViewer } from "@/lib/auth/viewer";
import { db } from "@/lib/db/client";
import { profiles, viewers } from "@/lib/db/schema";
import { canManageAccount } from "@/lib/content/roles";
import { MAX_VIEWERS_PER_ACCOUNT, MULTIPLE_VIEWERS_ENABLED } from "@/lib/viewers/config";
import { DEFAULT_LOCALE } from "@/lib/viewers/locales";
import { createViewerSchema } from "@/lib/viewers/validation";
import { hashPin } from "@/lib/viewers/pin";

/** Add a profile to the signed-in account — the owner only (see lib/content/roles). */
export async function POST(request: Request) {
  const resolved = await getCurrentViewer();
  if (!resolved) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!resolved.viewer) return NextResponse.json({ error: "viewer_required" }, { status: 403 });
  if (!canManageAccount(resolved.viewer)) {
    return NextResponse.json({ error: "Only the account owner can add profiles." }, { status: 403 });
  }
  const account = resolved.account;
  if (!MULTIPLE_VIEWERS_ENABLED) {
    return NextResponse.json({ error: "Adding profiles isn't available yet." }, { status: 403 });
  }

  const parsed = createViewerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid profile" }, { status: 400 });
  }

  const created = await db.transaction(async (tx) => {
    // Serialize concurrent creates for one account so the cap can't be beaten.
    await tx.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, account.id)).for("update");
    const [{ total, nextOrder }] = await tx
      .select({ total: sql<number>`count(*)::int`, nextOrder: sql<number>`coalesce(max(${viewers.sortOrder}) + 1, 0)::int` })
      .from(viewers)
      .where(eq(viewers.accountId, account.id));
    if (total >= MAX_VIEWERS_PER_ACCOUNT) return null;

    const [row] = await tx
      .insert(viewers)
      .values({
        accountId: account.id,
        name: parsed.data.name,
        avatarKey: parsed.data.avatarKey,
        role: parsed.data.role ?? "limited",
        locale: parsed.data.locale ?? DEFAULT_LOCALE,
        maxAge: parsed.data.maxAge ?? null,
        allowUnrated: parsed.data.allowUnrated ?? false,
        pinHash: parsed.data.pin ? hashPin(parsed.data.pin) : null,
        sortOrder: nextOrder,
      })
      .returning();
    return row;
  });

  if (!created) {
    return NextResponse.json({ error: `An account can have up to ${MAX_VIEWERS_PER_ACCOUNT} profiles.` }, { status: 400 });
  }
  return NextResponse.json({ id: created.id });
}
