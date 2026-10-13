/**
 * Removing a whole server from Roam: every library (with its items, watch history and the rest, see libraries/delete), its members'
 * places on it, invitations, playlists and storage connections. Nothing in anybody's storage is touched, and the accounts themselves
 * (and their other servers) stay.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, servers, storageConnections } from "@/lib/db/schema";
import { releaseConnections } from "@/lib/platform/accounts";
import { deleteLibrary } from "@/lib/libraries/delete";

export async function deleteServer(serverId: string): Promise<{ libraries: number }> {
  const libs = await db.select({ id: libraries.id }).from(libraries).where(eq(libraries.serverId, serverId));
  // A library's items and their records have no foreign key to the library, so each library is cleared out properly first.
  for (const l of libs) await deleteLibrary(l.id);
  // Outside accounts connected only to this server are unlinked at their provider before their sign-ins go.
  await releaseConnections((await db.select({ id: storageConnections.id }).from(storageConnections).where(eq(storageConnections.serverId, serverId))).map((c) => c.id));
  // Members, invitations, playlists and storage connections cascade with the server.
  await db.delete(servers).where(eq(servers.id, serverId));
  return { libraries: libs.length };
}
