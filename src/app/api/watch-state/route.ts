import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { watchState } from "@/lib/db/schema";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { libraryRemembersProgress } from "@/lib/libraries/profile";
import { dropFinished } from "@/lib/watchlist/queries";
import { recordWatch, secondsWatched } from "@/lib/stats/record";

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

  const auth = await authorizeOwner(ownerKind, ownerId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.status === 403 ? "Forbidden" : "Not found" }, { status: auth.status });
  }

  // Clips in a photo library and songs in a music library never resume (they always start from the beginning), so nothing is recorded.
  if (!libraryRemembersProgress(auth.libraryKind)) return NextResponse.json({ ok: true, recorded: false });

  // How far it moved since the last save is how long it was watched (see lib/stats/record), counted for the household.
  const [before] = await db
    .select({ positionSeconds: watchState.positionSeconds, savedAt: watchState.updatedAt })
    .from(watchState)
    .where(and(eq(watchState.viewerId, auth.member.viewer.id), eq(watchState.ownerKind, ownerKind), eq(watchState.ownerId, ownerId)));
  const now = new Date();
  await db
    .insert(watchState)
    .values({
      viewerId: auth.member.viewer.id,
      ownerKind,
      ownerId,
      positionSeconds,
      durationSeconds,
      finished: finished ?? false,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [watchState.viewerId, watchState.ownerKind, watchState.ownerId],
      set: {
        positionSeconds,
        durationSeconds,
        finished: finished ?? false,
        updatedAt: new Date(),
      },
    });

  await recordWatch(db, { serverId: auth.serverId, accountId: auth.member.profile.id, ownerKind, ownerId, seconds: secondsWatched(before ?? null, positionSeconds, now), now }).catch(() => undefined);

  // Finishing a movie, audiobook or (the last episode of) a show takes it off the watch list.
  if (finished) await dropFinished(db, auth.member.viewer.id, ownerKind === "title" ? { titleIds: [ownerId] } : { episodeIds: [ownerId] });

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

  const auth = await authorizeOwner(parsed.data.ownerKind, parsed.data.ownerId);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.status === 403 ? "Forbidden" : "Not found" }, { status: auth.status });
  }

  const [state] = await db
    .select()
    .from(watchState)
    .where(
      and(
        eq(watchState.viewerId, auth.member.viewer.id),
        eq(watchState.ownerKind, parsed.data.ownerKind),
        eq(watchState.ownerId, parsed.data.ownerId)
      )
    )
    .limit(1);

  return NextResponse.json(state ?? null);
}
