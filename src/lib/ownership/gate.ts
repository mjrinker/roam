/** The check every route that hands out something to play makes, when the server tracks ownership. */
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import type { PlayOwnerKind } from "@/lib/player/types";
import { isWatching, availabilityFor, beat, playUnitFor, takesAPlace } from "@/lib/ownership/sessions";
import { unavailableMessage } from "@/lib/ownership/rules";

/**
 * Null when the viewer may play this (and, with `take`, now holds a place if the server limits playing at once); otherwise the
 * response to send (423: nothing is wrong with the request, the copy just isn't available).
 */
export async function ownershipGate(who: { viewerId: string; accountId: string }, ownerKind: PlayOwnerKind, ownerId: string, opts: { take: boolean; paused?: boolean }): Promise<NextResponse | null> {
  const unit = await playUnitFor(db, ownerKind, ownerId);
  if (!unit) return null;
  const result = opts.take ? await beat(db, unit, who, opts.paused ?? false) : await availabilityFor(db, unit, who);
  if (result.ok) return null;
  return NextResponse.json(
    { error: unavailableMessage(result), code: result.code, unit: { titleId: unit.titleId, seasonId: unit.seasonId }, watching: await isWatching(db, unit, who.viewerId) },
    { status: 423, headers: { "Cache-Control": "no-store" } }
  );
}

/** Whether a player of this has to send heartbeats (the server limits playing at once for this kind of library). */
export async function needsHeartbeat(ownerKind: PlayOwnerKind, ownerId: string): Promise<boolean> {
  const unit = await playUnitFor(db, ownerKind, ownerId);
  return !!unit && (await takesAPlace(db, unit));
}
