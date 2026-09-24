import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { watchState } from "@/lib/db/schema";
import { getCurrentProfile } from "@/lib/auth/guards";

const patchSchema = z.object({
  ownerKind: z.enum(["title", "episode"]),
  ownerId: z.string().uuid(),
  positionSeconds: z.number().int().min(0),
  durationSeconds: z.number().int().min(0).optional(),
  finished: z.boolean().optional(),
});

/** Upserts the current profile's resume position. Called by the player. */
export async function PATCH(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { ownerKind, ownerId, positionSeconds, durationSeconds, finished } = parsed.data;

  await db
    .insert(watchState)
    .values({
      profileId: profile.id,
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
        positionSeconds,
        durationSeconds,
        finished: finished ?? false,
        updatedAt: new Date(),
      },
    });

  return NextResponse.json({ ok: true });
}

const querySchema = z.object({
  ownerKind: z.enum(["title", "episode"]),
  ownerId: z.string().uuid(),
});

export async function GET(request: Request) {
  const profile = await getCurrentProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    ownerKind: searchParams.get("ownerKind"),
    ownerId: searchParams.get("ownerId"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const [state] = await db
    .select()
    .from(watchState)
    .where(
      and(
        eq(watchState.profileId, profile.id),
        eq(watchState.ownerKind, parsed.data.ownerKind),
        eq(watchState.ownerId, parsed.data.ownerId)
      )
    )
    .limit(1);

  return NextResponse.json(state ?? null);
}
