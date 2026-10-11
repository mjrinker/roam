import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, librarySources, storageConnections, type StorageProviderKind } from "@/lib/db/schema";
import { parseStorageId } from "@/lib/storage/ids";

export interface ConnectionSummary {
  id: string;
  provider: StorageProviderKind;
  label: string;
  accountName: string | null;
  authStatus: "disconnected" | "connected" | "needs_reauth";
  /** How many of the server's libraries have a folder on it. */
  libraries: number;
}

/** A server's storage connections, oldest first, with how many libraries use each (no secrets). */
export async function listConnectionSummaries(serverId: string): Promise<ConnectionSummary[]> {
  const conns = await db
    .select({ id: storageConnections.id, provider: storageConnections.provider, label: storageConnections.label, accountName: storageConnections.accountName, authStatus: storageConnections.authStatus })
    .from(storageConnections)
    .where(eq(storageConnections.serverId, serverId))
    .orderBy(asc(storageConnections.createdAt), asc(storageConnections.id));
  const used = await connectionUse(serverId);
  return conns.map((c) => ({ ...c, libraries: used.get(c.id)?.size ?? 0 }));
}

/** Which libraries have a folder (the first one, or one added later) on each connection. */
export async function connectionUse(serverId: string): Promise<Map<string, Set<string>>> {
  const libs = await db.select({ id: libraries.id, root: libraries.boxFolderId }).from(libraries).where(eq(libraries.serverId, serverId));
  const ids = libs.map((l) => l.id);
  const extra = ids.length ? await db.select({ libraryId: librarySources.libraryId, root: librarySources.rootId }).from(librarySources).where(inArray(librarySources.libraryId, ids)) : [];
  const use = new Map<string, Set<string>>();
  for (const { libraryId, root } of [...libs.map((l) => ({ libraryId: l.id, root: l.root })), ...extra]) {
    const { connectionId } = parseStorageId(serverId, root);
    (use.get(connectionId) ?? use.set(connectionId, new Set()).get(connectionId)!).add(libraryId);
  }
  return use;
}

/** True when some library on this server already has this folder as its first folder or one added later. */
export async function folderInUse(rootId: string): Promise<boolean> {
  const [a] = await db.select({ id: libraries.id }).from(libraries).where(eq(libraries.boxFolderId, rootId)).limit(1);
  if (a) return true;
  const [b] = await db.select({ id: librarySources.id }).from(librarySources).where(eq(librarySources.rootId, rootId)).limit(1);
  return !!b;
}

