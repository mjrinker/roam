/** Reading and changing who may see a library. Callers have already checked that the actor is an admin of the library's server. */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraries, libraryMembers, profiles, serverMembers, type LibraryAccess } from "@/lib/db/schema";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface AccessPerson {
  accountId: string;
  /** Display name, or the email when the account has none. */
  name: string;
  /** Server admins always see every library, so they're shown as always-allowed. */
  isAdmin: boolean;
  /** Has an explicit grant on this library. */
  granted: boolean;
}

export interface LibraryAccessView {
  access: LibraryAccess;
  people: AccessPerson[];
}

const MAX_PEOPLE = 500;

/** The library's access mode and every account on its server, marked with who was explicitly given access. */
export async function getLibraryAccess(ex: Db, libraryId: string): Promise<LibraryAccessView | null> {
  const [library] = await ex.select().from(libraries).where(eq(libraries.id, libraryId));
  if (!library) return null;
  const rows = await ex
    .select({
      accountId: serverMembers.profileId,
      email: profiles.email,
      displayName: profiles.displayName,
      role: serverMembers.role,
      granted: libraryMembers.accountId,
    })
    .from(serverMembers)
    .innerJoin(profiles, eq(profiles.id, serverMembers.profileId))
    .leftJoin(libraryMembers, and(eq(libraryMembers.libraryId, libraryId), eq(libraryMembers.accountId, serverMembers.profileId)))
    .where(eq(serverMembers.serverId, library.serverId))
    .orderBy(asc(profiles.displayName), asc(profiles.email))
    .limit(MAX_PEOPLE);
  return {
    access: library.access,
    people: rows.map((r) => ({
      accountId: r.accountId,
      name: r.displayName?.trim() || r.email,
      isAdmin: r.role === "admin",
      granted: r.granted !== null,
    })),
  };
}

export type SetAccessResult = { ok: true } | { ok: false; reason: "not_found" | "not_members" };

/**
 * Sets the access mode and applies a change to the grant list in one transaction: `grant` adds
 * accounts and `revoke` removes them (a diff, so accounts the caller never saw are untouched,
 * however large the server). Every account in `grant` must be a member of the library's server
 * (server admins are skipped: they always have access). Grants are kept when the mode is
 * 'everyone', so switching back and forth loses nothing.
 */
export async function setLibraryAccess(
  ex: Db,
  args: { libraryId: string; actorAccountId: string; access: LibraryAccess; grant: string[]; revoke: string[] }
): Promise<SetAccessResult> {
  return ex.transaction(async (tx): Promise<SetAccessResult> => {
    const [library] = await tx.select().from(libraries).where(eq(libraries.id, args.libraryId)).for("update");
    if (!library) return { ok: false, reason: "not_found" };

    const wanted = [...new Set(args.grant)];
    const members = wanted.length
      ? await tx
          .select({ id: serverMembers.profileId, role: serverMembers.role })
          .from(serverMembers)
          .where(and(eq(serverMembers.serverId, library.serverId), inArray(serverMembers.profileId, wanted)))
      : [];
    if (members.length !== wanted.length) return { ok: false, reason: "not_members" };
    const grantees = members.filter((m) => m.role !== "admin").map((m) => m.id);

    await tx.update(libraries).set({ access: args.access }).where(eq(libraries.id, library.id));
    const revoked = [...new Set(args.revoke)].filter((id) => !grantees.includes(id));
    if (revoked.length) {
      await tx.delete(libraryMembers).where(and(eq(libraryMembers.libraryId, library.id), inArray(libraryMembers.accountId, revoked)));
    }
    if (grantees.length) {
      await tx
        .insert(libraryMembers)
        .values(grantees.map((accountId) => ({ libraryId: library.id, serverId: library.serverId, accountId, grantedByAccountId: args.actorAccountId })))
        .onConflictDoNothing();
    }
    return { ok: true };
  });
}
