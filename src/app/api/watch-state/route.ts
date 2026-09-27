import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { watchState } from "@/lib/db/schema";
import { getCurrentServerMember } from "@/lib/auth/guards";
import { resolveServerIdForOwner } from "@/lib/auth/resolve-server";

const patchSchema = z.object({
  ownerKind: z.enum(["title", "episode"]),
  ownerId: z.string().uuid(),
  positionSeconds: z.number().int().min(0),
  durationSeconds: z.number().int().min(0).optional(),
  finished: z.boolean().optional(),
});

/**
 * Upserts the current profile's resume position. Called by the player.
 * Same server-membership check as GET below (and as /api/play) — a write
 * needs the same authorization as a read, otherwise anyone signed in
 * could pollute another tenant's watch_state rows even if they can't
 * read them.
 */
export async function PATCH(request: Request) {
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { ownerKind, ownerId, positionSeconds, durationSeconds, finished } = parsed.data;

  const serverId = await resolveServerIdForOwner(ownerKind, ownerId);
  if (!serverId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const member = await getCurrentServerMember(serverId);
  if (!member) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await db
    .insert(watchState)
    .values({
      profileId: member.profile.id,
      viewerId: member.viewer.id,
      ownerKind,
      ownerId,
      positionSeconds,
      durationSeconds,
      finished: finished ?? false,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [watchState.profileId, watchState.ownerKind, watchState.ownerId],
      set: {
        viewerId: member.viewer.id,
        positionSeconds,
        durationSeconds,
        finished: finished ?? false,
        updatedAt: new Date(),
      },
    });

  return NextResponse.json({ ok: true });
}

// navigator.sendBeacon (used by the player so progress survives page unload)
// can only send POST.
export const POST = PATCH;

const querySchema = z.object({
  ownerKind: z.enum(["title", "episode"]),
  ownerId: z.string().uuid(),
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    ownerKind: searchParams.get("ownerKind"),
    ownerId: searchParams.get("ownerId"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const serverId = await resolveServerIdForOwner(parsed.data.ownerKind, parsed.data.ownerId);
  if (!serverId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const member = await getCurrentServerMember(serverId);
  if (!member) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [state] = await db
    .select()
    .from(watchState)
    .where(
      and(
        eq(watchState.viewerId, member.viewer.id),
        eq(watchState.ownerKind, parsed.data.ownerKind),
        eq(watchState.ownerId, parsed.data.ownerId)
      )
    )
    .limit(1);

  return NextResponse.json(state ?? null);
}
