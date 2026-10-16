/**
 * A profile's watch list: movies, shows and audiobooks it means to get to. Private to the profile (only its viewer reads or writes it);
 * the list only ever shows what that profile may still see, and a title drops off by itself once the profile has finished it.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { watchlistItems } from "@/lib/db/schema";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { WATCHLIST_KINDS } from "./kinds";

export type WatchlistResult = { ok: true } | { ok: false; status: 403 | 404 };

/** Puts a title on the signed-in profile's watch list, or takes it off. Anything the profile can't see is "not found". */
export async function setOnWatchlist(args: { titleId: string; on: boolean }): Promise<WatchlistResult> {
  const auth = await authorizeOwner("title", args.titleId, { titleKinds: [...WATCHLIST_KINDS] });
  if (!auth.ok) return { ok: false, status: auth.status === 403 ? 403 : 404 };
  const viewerId = auth.member.viewer.id;
  if (args.on) await db.insert(watchlistItems).values({ viewerId, titleId: args.titleId }).onConflictDoNothing();
  else await db.delete(watchlistItems).where(and(eq(watchlistItems.viewerId, viewerId), eq(watchlistItems.titleId, args.titleId)));
  return { ok: true };
}
