import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getCurrentProfile } from "@/lib/auth/guards";
import { db } from "@/lib/db/client";
import { profiles, viewers } from "@/lib/db/schema";
import { MAX_VIEWERS_PER_ACCOUNT, MULTIPLE_VIEWERS_ENABLED } from "@/lib/viewers/config";
import { DEFAULT_LOCALE } from "@/lib/viewers/locales";
import { createViewerSchema } from "@/lib/viewers/validation";

/** Add a profile to the signed-in account. */
export async function POST(request: Request) {
  const account = await getCurrentProfile();
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
        locale: parsed.data.locale ?? DEFAULT_LOCALE,
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
