/**
 * Whether an account may see a library, and the SQL for it. This is the one place that decides
 * "may this account see this library": a library is visible iff it belongs to the actor's server
 * AND (it is open to everyone, OR the actor is a server admin, OR the actor's account was given
 * access in library_members). Every query that returns or authorizes library content for a viewer
 * goes through here, on top of the age check in lib/content/access (see enforcement.test.ts).
 *
 * The actor can only come from a server membership that was already checked (getCurrentServerMember,
 * requireServerMember, or the playlist context), so the server binding can't be forgotten: the
 * helper never returns a bare `undefined`.
 */
import { and, eq, exists, or, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { libraries, libraryMembers } from "@/lib/db/schema";

export interface LibraryActor {
  serverId: string;
  /** The signed-in ACCOUNT (profiles.id), not the viewer. */
  accountId: string;
  /** True for a server admin (server_members.role = 'admin'). */
  isAdmin: boolean;
}

/** Builds the actor from a verified server membership. */
export function libraryActor(member: { profile: { id: string }; role: "admin" | "viewer" }, serverId: string): LibraryActor {
  return { serverId, accountId: member.profile.id, isAdmin: member.role === "admin" };
}

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** SQL condition: `libs` (the libraries table or an alias of it) is visible to `actor`. */
export function libraryVisible(ex: Db, actor: LibraryActor, libs: typeof libraries = libraries): SQL {
  const bound = eq(libs.serverId, actor.serverId);
  if (actor.isAdmin) return bound;
  return and(
    bound,
    or(
      eq(libs.access, "everyone"),
      exists(
        ex
          .select({ one: libraryMembers.accountId })
          .from(libraryMembers)
          .where(and(eq(libraryMembers.libraryId, libs.id), eq(libraryMembers.accountId, actor.accountId)))
      )
    )
  ) as SQL;
}

/** True when `libraryId` is visible to `actor`. */
export async function canSeeLibrary(ex: Db, actor: LibraryActor, libraryId: string): Promise<boolean> {
  const [row] = await ex
    .select({ id: libraries.id })
    .from(libraries)
    .where(and(eq(libraries.id, libraryId), libraryVisible(ex, actor, libraries)))
    .limit(1);
  return Boolean(row);
}
