import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getCurrentViewer } from "@/lib/auth/viewer";
import { db } from "@/lib/db/client";
import { viewers } from "@/lib/db/schema";
import { canEditExtended, canEditProfile, canManageAccount } from "@/lib/content/roles";
import { MULTIPLE_VIEWERS_ENABLED } from "@/lib/viewers/config";
import { VIEWER_COOKIE } from "@/lib/viewers/cookie";
import { hashPin, verifyPin } from "@/lib/viewers/pin";
import { extendedEditSchema, selfEditSchema } from "@/lib/viewers/validation";

/**
 * Edit one of the signed-in account's profiles.
 *
 * Roles (lib/content/roles): the owner may edit any profile, including its
 * role, rating limit, and PIN. An admin may edit only itself, but with the
 * same full set of fields. A limited profile may only rename itself or
 * change its own avatar — not its language, rating limit, or PIN, which is
 * what makes a limit the owner set actually stick. If the ACTING profile
 * itself has a PIN, an extended edit (on itself or anyone) must include that
 * PIN, so a device left signed in to it can't be used to quietly loosen
 * things.
 */
export async function PATCH(request: Request, ctx: RouteContext<"/api/viewers/[id]">) {
  const { id } = await ctx.params;
  const resolved = await getCurrentViewer();
  if (!resolved) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!resolved.viewer) return NextResponse.json({ error: "viewer_required" }, { status: 403 });

  const target = resolved.viewers.find((v) => v.id === id);
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const actor = resolved.viewer;
  if (!canEditProfile(actor, id)) {
    return NextResponse.json({ error: "Only the account owner can edit other profiles." }, { status: 403 });
  }
  const body = await request.json().catch(() => null);

  if (!canEditExtended(actor, id)) {
    const parsed = selfEditSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid profile" }, { status: 400 });
    }
    await db.update(viewers).set(parsed.data).where(eq(viewers.id, id));
    return NextResponse.json({ ok: true });
  }

  const parsed = extendedEditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid profile" }, { status: 400 });
  }
  const { currentPin, role, ...changes } = parsed.data;

  if (role !== undefined) {
    // Reassigning a role is an owner-on-someone-else action: the owner can't
    // be reassigned (there must always be exactly one), and nobody
    // (including the owner) changes their own role through this field.
    if (!canManageAccount(actor) || id === actor.id) {
      return NextResponse.json({ error: "Can't change that profile's role." }, { status: 403 });
    }
  }

  if (actor.pinHash) {
    if (!currentPin || !verifyPin(currentPin, actor.pinHash)) {
      return NextResponse.json({ error: "Incorrect PIN" }, { status: 401 });
    }
  }

  const { pin, ...rest } = changes;
  await db
    .update(viewers)
    .set({
      ...rest,
      ...(role !== undefined ? { role } : {}),
      ...(pin === undefined ? {} : { pinHash: pin === null ? null : hashPin(pin), pinVersion: target.pinVersion + 1 }),
    })
    .where(eq(viewers.id, id));

  // A PIN change invalidates that profile's existing selection cookie; if it's
  // the one just edited and currently selected, drop it so this device re-checks.
  if (actor.id === id && "pin" in changes) (await cookies()).delete(VIEWER_COOKIE);
  return NextResponse.json({ ok: true });
}

/** Delete one of the signed-in account's profiles — owner-only, never the owner itself, and never the last profile. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/viewers/[id]">) {
  const { id } = await ctx.params;
  const resolved = await getCurrentViewer();
  if (!resolved) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!resolved.viewer) return NextResponse.json({ error: "viewer_required" }, { status: 403 });
  if (!canManageAccount(resolved.viewer)) {
    return NextResponse.json({ error: "Only the account owner can delete profiles." }, { status: 403 });
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
    if (target.role === "owner") return "is_owner" as const;
    if (mine.length <= 1) return "last" as const;
    await tx.delete(viewers).where(eq(viewers.id, id));
    return "ok" as const;
  });

  if (deleted === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (deleted === "is_owner") return NextResponse.json({ error: "The account owner's profile can't be deleted." }, { status: 400 });
  if (deleted === "last") return NextResponse.json({ error: "An account needs at least one profile." }, { status: 400 });

  // Deleting the profile that's currently selected sends the device back to the chooser.
  if (resolved.viewer.id === id) (await cookies()).delete(VIEWER_COOKIE);
  return NextResponse.json({ ok: true });
}
