import { cache } from "react";
import { cookies } from "next/headers";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { viewers, type Viewer } from "@/lib/db/schema";
import { getCurrentProfile } from "@/lib/auth/guards";
import type { Profile } from "@/lib/auth/guards";
import { VIEWER_COOKIE, verifyViewerCookie, viewerIdFromCookie } from "@/lib/viewers/cookie";
import { VIEWER_NAME_MAX_LENGTH } from "@/lib/viewers/config";

/** The default name for an account's first profile. */
export function defaultViewerName(account: Pick<Profile, "displayName" | "email">): string {
  const name = account.displayName?.trim() || account.email.split("@")[0]?.trim() || "Me";
  return name.slice(0, VIEWER_NAME_MAX_LENGTH);
}

/**
 * Makes sure an account has its default profile. The default reuses the
 * account's own id, so this is idempotent and safe to race.
 */
export async function ensureDefaultViewer(account: Pick<Profile, "id" | "displayName" | "email">): Promise<Viewer> {
  const [created] = await db
    .insert(viewers)
    .values({ id: account.id, accountId: account.id, name: defaultViewerName(account) })
    .onConflictDoNothing({ target: viewers.id })
    .returning();
  if (created) return created;

  const [existing] = await db.select().from(viewers).where(eq(viewers.id, account.id)).limit(1);
  return existing;
}

export const listViewers = cache(async (accountId: string): Promise<Viewer[]> =>
  db
    .select()
    .from(viewers)
    .where(eq(viewers.accountId, accountId))
    .orderBy(asc(viewers.sortOrder), asc(viewers.createdAt))
);

export type ViewerResolution =
  | { account: Profile; viewer: Viewer; viewers: Viewer[] }
  | { account: Profile; viewer: null; viewers: Viewer[] };

/**
 * Who is using this account right now. Signed out → null. Otherwise the
 * selected profile (from the signed cookie, re-checked against the database),
 * or the account's only profile when it has one and it has no PIN, or
 * `viewer: null` meaning "show the Who's watching? chooser".
 */
export const getCurrentViewer = cache(async (): Promise<ViewerResolution | null> => {
  const account = await getCurrentProfile();
  if (!account) return null;

  let all = await listViewers(account.id);
  if (all.length === 0) {
    all = [await ensureDefaultViewer(account)];
  }

  const cookie = (await cookies()).get(VIEWER_COOKIE)?.value;
  if (cookie) {
    const id = viewerIdFromCookie(cookie);
    // Looking the id up among THIS account's profiles is the ownership check.
    const selected = all.find((v) => v.id === id);
    if (selected && verifyViewerCookie(cookie, { viewerId: selected.id, accountId: account.id, pinVersion: selected.pinVersion })) {
      return { account, viewer: selected, viewers: all };
    }
  }

  if (all.length === 1 && !all[0].pinHash) {
    return { account, viewer: all[0], viewers: all };
  }
  return { account, viewer: null, viewers: all };
});
