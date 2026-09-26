import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, seasons, titles } from "@/lib/db/schema";
import type { PlayOwnerKind } from "@/lib/player/types";

/**
 * Resolves which server owns a title or episode. Content ownership ids are
 * globally unique uuids never reused across tenants, so this is a safe,
 * tamper-proof way to authorize /api/play and /api/watch-state without
 * trusting a client-supplied serverId — always check requireServerMember
 * against the RESOLVED value, not anything the caller sent.
 */
export async function resolveServerIdForOwner(
  ownerKind: PlayOwnerKind,
  ownerId: string
): Promise<string | null> {
  if (ownerKind === "title") {
    const [row] = await db
      .select({ serverId: libraries.serverId })
      .from(titles)
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(eq(titles.id, ownerId))
      .limit(1);
    return row?.serverId ?? null;
  }

  const [row] = await db
    .select({ serverId: libraries.serverId })
    .from(episodes)
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .innerJoin(titles, eq(seasons.titleId, titles.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(eq(episodes.id, ownerId))
    .limit(1);
  return row?.serverId ?? null;
}

/** Same idea, for a title id specifically (used by the admin match-fix route). */
export async function resolveServerIdForTitle(titleId: string): Promise<string | null> {
  return resolveServerIdForOwner("title", titleId);
}

/** Same idea, for a library id (used by the scan route). */
export async function resolveServerIdForLibrary(libraryId: string): Promise<string | null> {
  const [row] = await db
    .select({ serverId: libraries.serverId })
    .from(libraries)
    .where(eq(libraries.id, libraryId))
    .limit(1);
  return row?.serverId ?? null;
}
