import { count, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { profiles, servers, serverMembers } from "@/lib/db/schema";
import type { ServerRole } from "@/lib/auth/guards";

const MAX_SERVERS_PER_USER = Number(process.env.MAX_SERVERS_PER_USER ?? 3);

export type CreateServerResult =
  | { ok: true; server: typeof servers.$inferSelect }
  | { ok: false; reason: "too_many_servers" | "guest" };

/**
 * Creates a server owned by `profileId` and makes them its first admin
 * member, transactionally. Capped per-user (owned servers, not
 * memberships — joining others' servers isn't the resource cost being
 * guarded against) now that sign-up is open to anyone.
 */
export async function createServer(
  profileId: string,
  name: string
): Promise<CreateServerResult> {
  // A guest (an anonymous demo visitor) can watch, not own anything.
  const [account] = await db.select({ isGuest: profiles.isGuest }).from(profiles).where(eq(profiles.id, profileId)).limit(1);
  if (account?.isGuest) return { ok: false, reason: "guest" };

  const [{ ownedCount }] = await db
    .select({ ownedCount: count() })
    .from(servers)
    .where(eq(servers.ownerId, profileId));

  if (ownedCount >= MAX_SERVERS_PER_USER) {
    return { ok: false, reason: "too_many_servers" };
  }

  const server = await db.transaction(async (tx) => {
    const [newServer] = await tx
      .insert(servers)
      .values({ name, ownerId: profileId })
      .returning();
    await tx
      .insert(serverMembers)
      .values({ serverId: newServer.id, profileId, role: "admin" });
    return newServer;
  });

  return { ok: true, server };
}

export interface ServerMembershipSummary {
  serverId: string;
  serverName: string;
  role: ServerRole;
  boxAuthStatus: "disconnected" | "connected" | "needs_reauth";
}

/** All servers a profile belongs to (owned or joined via invite). */
export async function listServerMemberships(
  profileId: string
): Promise<ServerMembershipSummary[]> {
  return db
    .select({
      serverId: servers.id,
      serverName: servers.name,
      role: serverMembers.role,
      boxAuthStatus: servers.boxAuthStatus,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.profileId, profileId));
}

/**
 * Where to send a profile right after sign-in (or after landing on `/`).
 * 0 memberships -> the servers hub (nothing else to do but create/join
 * one); exactly 1 -> straight into it; 2+ -> the hub, to pick one.
 */
export async function resolveLandingPath(profileId: string): Promise<string> {
  const memberships = await listServerMemberships(profileId);
  if (memberships.length === 1) {
    return `/s/${memberships[0].serverId}/library`;
  }
  return "/servers";
}
