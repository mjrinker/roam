import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { episodes, libraries, seasons, titleExtras, titles, type LibraryKind, type TitleKind } from "@/lib/db/schema";
import type { PlayOwnerKind } from "@/lib/player/types";
import { getCurrentServerMember, type ServerMembership } from "@/lib/auth/guards";
import { isAllowed } from "@/lib/content/access";
import { canSeeLibrary, libraryActor } from "@/lib/content/library-access";
import { PLAYABLE_TITLE_KINDS } from "@/lib/libraries/profile";
import type { RatingAges } from "@/lib/content/ratings";

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
  if (ownerKind === "extra") {
    const [row] = await db
      .select({ serverId: libraries.serverId })
      .from(titleExtras)
      .innerJoin(titles, eq(titleExtras.titleId, titles.id))
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(eq(titleExtras.id, ownerId))
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

/**
 * Same lookup as resolveServerIdForOwner, plus the rating_ages that gate
 * access to it — an episode always uses its show's, since TMDB has no
 * per-episode certification. Null means the owner id doesn't exist at all.
 */
export async function resolveOwner(
  ownerKind: PlayOwnerKind,
  ownerId: string
): Promise<{ serverId: string; libraryId: string; libraryKind: LibraryKind; ratingAges: RatingAges | null; titleKind: TitleKind | "episode" } | null> {
  if (ownerKind === "title") {
    const [row] = await db
      .select({ serverId: libraries.serverId, libraryId: libraries.id, libraryKind: libraries.kind, ratingAges: titles.ratingAges, titleKind: titles.kind })
      .from(titles)
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(eq(titles.id, ownerId))
      .limit(1);
    return row ?? null;
  }
  if (ownerKind === "extra") {
    // An extra is always rated and shown like the movie it belongs to.
    const [row] = await db
      .select({ serverId: libraries.serverId, libraryId: libraries.id, libraryKind: libraries.kind, ratingAges: titles.ratingAges, titleKind: titles.kind })
      .from(titleExtras)
      .innerJoin(titles, eq(titleExtras.titleId, titles.id))
      .innerJoin(libraries, eq(titles.libraryId, libraries.id))
      .where(eq(titleExtras.id, ownerId))
      .limit(1);
    return row ?? null;
  }

  const [row] = await db
    .select({ serverId: libraries.serverId, libraryId: libraries.id, libraryKind: libraries.kind, ratingAges: titles.ratingAges })
    .from(episodes)
    .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
    .innerJoin(titles, eq(seasons.titleId, titles.id))
    .innerJoin(libraries, eq(titles.libraryId, libraries.id))
    .where(eq(episodes.id, ownerId))
    .limit(1);
  return row ? { ...row, titleKind: "episode" as const } : null;
}

export type OwnerAuthorization =
  | { ok: true; member: ServerMembership; serverId: string; libraryId: string; libraryKind: LibraryKind }
  | { ok: false; status: 404 | 403 };

/**
 * The single choke point for "may the current profile play/see this title or
 * episode": resolves the owner, checks server membership, and checks the
 * profile's rating limit, and that its library is visible to the account (see
 * lib/content/library-access) — the last two collapse to 404 on failure so a blocked
 * or nonexistent item look the same from the outside (see lib/content/access
 * and enforcement.test.ts). Used by /api/play, the audiobook manifest and
 * segment routes, /api/watch-state, and the watch page.
 */
export async function authorizeOwner(
  ownerKind: PlayOwnerKind,
  ownerId: string,
  opts: { titleKinds?: readonly TitleKind[] } = {}
): Promise<OwnerAuthorization> {
  const owner = await resolveOwner(ownerKind, ownerId);
  if (!owner) return { ok: false, status: 404 };
  // A title of a kind this caller doesn't serve is "not found", exactly like one that doesn't exist.
  if (owner.titleKind !== "episode" && !(opts.titleKinds ?? PLAYABLE_TITLE_KINDS).includes(owner.titleKind)) {
    return { ok: false, status: 404 };
  }

  const member = await getCurrentServerMember(owner.serverId);
  if (!member) return { ok: false, status: 403 };

  if (!isAllowed(member.viewer, owner.ratingAges)) return { ok: false, status: 404 };
  if (!(await canSeeLibrary(db, libraryActor(member, owner.serverId), owner.libraryId))) return { ok: false, status: 404 };
  return { ok: true, member, serverId: owner.serverId, libraryId: owner.libraryId, libraryKind: owner.libraryKind };
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
