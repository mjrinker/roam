import { NextResponse } from "next/server";
import { getCurrentServerAdmin } from "@/lib/auth/guards";
import { StorageReauthRequiredError } from "@/lib/storage/reauth";
import { StorageHttpError } from "@/lib/storage/http";
import { formatStorageId } from "@/lib/storage/ids";
import { loadConnection, providerForConnection } from "@/lib/storage/registry";
import { createStorageForServer } from "@/lib/storage/server-storage";

/**
 * Folder-picker data source: the subfolders of a folder on one of the server's connections. Without `folderId` it lists the
 * connection's top. Ids in and out are stored ids (see lib/storage/ids).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("serverId");
  const connectionId = searchParams.get("connectionId") ?? serverId;
  if (!serverId || !connectionId) return NextResponse.json({ error: "Missing serverId" }, { status: 400 });
  if (!(await getCurrentServerAdmin(serverId))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const conn = await loadConnection(connectionId);
  // A server's own id names its original Box connection even before it has a row of its own.
  if (conn ? conn.serverId !== serverId : connectionId !== serverId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const provider = providerForConnection(conn ?? { id: serverId, provider: "box" });
    const rootNative = provider.rootFolderId?.() ?? "0";
    const folderId = searchParams.get("folderId") ?? formatStorageId(serverId, connectionId, rootNative);
    const entries = await createStorageForServer(serverId).listFolder(folderId);
    const folders = entries.filter((e) => e.kind === "folder").sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ folders, rootId: formatStorageId(serverId, connectionId, rootNative) });
  } catch (err) {
    if (err instanceof StorageReauthRequiredError) {
      return NextResponse.json({ error: "This connection needs to be reconnected." }, { status: 424 });
    }
    // Only an admin gets here, so the reason is shown: it is what tells them what to fix.
    const detail = err instanceof StorageHttpError || err instanceof Error ? err.message.slice(0, 300) : "";
    return NextResponse.json({ error: detail ? `Failed to browse that folder: ${detail}` : "Failed to browse that folder." }, { status: 500 });
  }
}
