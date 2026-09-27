import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getCurrentViewer } from "@/lib/auth/viewer";
import { db } from "@/lib/db/client";
import { viewers } from "@/lib/db/schema";
import { MULTIPLE_VIEWERS_ENABLED } from "@/lib/viewers/config";
import { VIEWER_COOKIE } from "@/lib/viewers/cookie";
import { hashPin, verifyPin } from "@/lib/viewers/pin";
import { managerEditSchema, selfEditSchema } from "@/lib/viewers/validation";

/**
 * Edit one of the signed-in account's profiles.
 *
 * Only an unrestricted profile (a "manager" — one with no rating limit) may
 * edit anything beyond its own name and avatar: not another profile, and not
 * its own language, rating limit, or PIN. This is what makes a limit mean
 * something — a restricted profile can't just raise its own ceiling. If the
 * acting manager itself has a PIN, every manager-level edit (on any profile,
 * including itself) must include that PIN, so a device left signed in to a
 * manager's profile can't be used to quietly loosen restrictions.
 */
export async function PATCH(request: Request, ctx: RouteContext<"/api/viewers/[id]">) {
  const { id } = await ctx.params;
  const resolved = await getCurrentViewer();
  if (!resolved) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!resolved.viewer) return NextResponse.json({ error: "viewer_required" }, { status: 403 });

  const target = resolved.viewers.find((v) => v.id === id);
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isManager = resolved.viewer.maxAge === null;
  const isSelf = resolved.viewer.id === id;
  const body = await request.json().catch(() => null);

  if (!isManager) {
    if (!isSelf) {
      return NextResponse.json({ error: "Only an unrestricted profile can edit other profiles." }, { status: 403 });
    }
    const parsed = selfEditSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid profile" }, { status: 400 });
    }
    await db.update(viewers).set(parsed.data).where(eq(viewers.id, id));
    return NextResponse.json({ ok: true });
  }

  const parsed = managerEditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid profile" }, { status: 400 });
  }
  const { currentPin, ...changes } = parsed.data;

  if (resolved.viewer.pinHash) {
    if (!currentPin || !verifyPin(currentPin, resolved.viewer.pinHash)) {
      return NextResponse.json({ error: "Incorrect PIN" }, { status: 401 });
    }
  }

  const result = await db.transaction(async (tx) => {
    // Serialize with other edits/deletes on this account so the "at least
    // one manager" invariant can't be beaten by a race.
    const mine = await tx
      .select()
      .from(viewers)
      .where(eq(viewers.accountId, resolved.account.id))
      .for("update");
    const row = mine.find((v) => v.id === id);
    if (!row) return "not_found" as const;

    const restricting = "maxAge" in changes && changes.maxAge !== null && row.maxAge === null;
    if (restricting) {
      const otherManagers = mine.filter((v) => v.id !== id && v.maxAge === null);
      if (otherManagers.length === 0) return "last_manager" as const;
    }

    const { pin, ...rest } = changes;
    await tx
      .update(viewers)
      .set({
        ...rest,
        ...(pin === undefined ? {} : { pinHash: pin === null ? null : hashPin(pin), pinVersion: row.pinVersion + 1 }),
      })
      .where(eq(viewers.id, id));
    return "ok" as const;
  });

  if (result === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (result === "last_manager") {
    return NextResponse.json({ error: "An account needs at least one unrestricted profile." }, { status: 400 });
  }

  // A PIN change invalidates that profile's existing selection cookie; if it's
  // the one just edited and currently selected, drop it so this device re-checks.
  if (isSelf && "pin" in changes) (await cookies()).delete(VIEWER_COOKIE);
  return NextResponse.json({ ok: true });
}

/** Delete one of the signed-in account's profiles — manager-only, and never the last profile or last unrestricted one. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/viewers/[id]">) {
  const { id } = await ctx.params;
  const resolved = await getCurrentViewer();
  if (!resolved) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!resolved.viewer) return NextResponse.json({ error: "viewer_required" }, { status: 403 });
  if (resolved.viewer.maxAge !== null) {
    return NextResponse.json({ error: "Only an unrestricted profile can delete profiles." }, { status: 403 });
  }
  if (!MULTIPLE_VIEWERS_ENABLED) {
    return NextResponse.json({ error: "Deleting profiles isn't available yet." }, { status: 403 });
  }

  const deleted = await db.transaction(async (tx) => {
    const mine = await tx
      .select()
      .from(viewers)
      .where(eq(viewers.accountId, resolved.account.id))
      .for("update");
    const target = mine.find((v) => v.id === id);
    if (!target) return "not_found" as const;
    if (mine.length <= 1) return "last" as const;
    if (target.maxAge === null && !mine.some((v) => v.id !== id && v.maxAge === null)) {
      return "last_manager" as const;
    }
    await tx.delete(viewers).where(eq(viewers.id, id));
    return "ok" as const;
  });

  if (deleted === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (deleted === "last") return NextResponse.json({ error: "An account needs at least one profile." }, { status: 400 });
  if (deleted === "last_manager") {
    return NextResponse.json({ error: "An account needs at least one unrestricted profile." }, { status: 400 });
  }

  // Deleting the profile that's currently selected sends the device back to the chooser.
  if (resolved.viewer.id === id) (await cookies()).delete(VIEWER_COOKIE);
  return NextResponse.json({ ok: true });
}
