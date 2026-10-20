import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { storageConnections, type StorageProviderKind } from "@/lib/db/schema";
import { createBoxProviderForServer } from "@/lib/storage/box";
import { boxWriteMethods } from "@/lib/storage/box-write";
import { createDropboxProvider } from "@/lib/storage/dropbox";
import { createGoogleDriveProvider } from "@/lib/storage/google-drive";
import { createOneDriveProvider } from "@/lib/storage/onedrive";
import type { StorageProvider } from "@/lib/storage/provider";

export type StorageConnection = typeof storageConnections.$inferSelect;

/** A connection whose kind of storage isn't supported by this version of Roam. */
export class UnsupportedProviderError extends Error {
  constructor(public readonly provider: string) {
    super(`Storage provider "${provider}" is not supported`);
    this.name = "UnsupportedProviderError";
  }
}

/** The provider behind one connection, speaking in that provider's own ids. */
export function providerForConnection(conn: Pick<StorageConnection, "id" | "provider">): StorageProvider {
  const kind: StorageProviderKind = conn.provider;
  switch (kind) {
    case "box":
      // Box's code is keyed by the connection's id (a server's original connection has the server's id).
      return { ...createBoxProviderForServer(conn.id), ...boxWriteMethods(conn.id) };
    case "dropbox":
      return createDropboxProvider(conn.id);
    case "onedrive":
      return createOneDriveProvider(conn.id);
    case "gdrive":
      return createGoogleDriveProvider(conn.id);
    default:
      throw new UnsupportedProviderError(kind);
  }
}

export async function loadConnection(connectionId: string): Promise<StorageConnection | null> {
  const [row] = await db.select().from(storageConnections).where(eq(storageConnections.id, connectionId)).limit(1);
  return row ?? null;
}

export async function loadServerConnections(serverId: string): Promise<StorageConnection[]> {
  return db.select().from(storageConnections).where(eq(storageConnections.serverId, serverId));
}
