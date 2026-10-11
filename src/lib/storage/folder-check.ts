import { loadConnection } from "@/lib/storage/registry";
import { parseStorageId } from "@/lib/storage/ids";
import { folderInUse } from "@/lib/storage/connections";

/** Why a folder can't be used as a library folder on this server, or null when it can: its connection must be this server's own, and no library may already have it. */
export async function whyFolderUnusable(serverId: string, storedFolderId: string): Promise<string | null> {
  const { connectionId } = parseStorageId(serverId, storedFolderId);
  const conn = await loadConnection(connectionId);
  // A server's own id names its original Box connection even before it has a row of its own.
  const ours = conn ? conn.serverId === serverId : connectionId === serverId;
  if (!ours) return "That folder isn't on one of this server's connections.";
  if (await folderInUse(storedFolderId)) return "A library already uses that folder.";
  return null;
}
