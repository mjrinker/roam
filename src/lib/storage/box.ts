import { BoxApiError, BoxClient, BoxDeveloperTokenAuth } from "box-node-sdk";
import type { StorageEntry, StorageProvider, StreamingUrl } from "./provider";
import { ensureFreshAccessToken, withBoxClient } from "./box-token-storage";

/**
 * Per-server Box access, authenticated as that server's own connected Box
 * account (standard 3-legged OAuth — see box-token-storage.ts), not a
 * shared service account. `BOX_CLIENT_ID`/`BOX_CLIENT_SECRET` identify
 * this app to Box for the OAuth handshake; they're the same for every
 * server (one app registration, many end-user grants).
 */

const PAGE_SIZE = 1000;
const MAX_ENTRIES = 20000; // sanity cap against runaway pagination

async function listFolder(serverId: string, folderId: string): Promise<StorageEntry[]> {
  return withBoxClient(serverId, async (client) => {
    const entries: StorageEntry[] = [];
    let offset = 0;

    for (;;) {
      const page = await client.folders.getFolderItems(folderId, {
        queryParams: {
          fields: ["name", "size", "type"],
          offset,
          limit: PAGE_SIZE,
        },
      });

      for (const item of page.entries ?? []) {
        if (item.type === "file") {
          entries.push({
            id: item.id,
            name: item.name ?? item.id,
            kind: "file",
            sizeBytes: item.size,
          });
        } else if (item.type === "folder") {
          entries.push({ id: item.id, name: item.name ?? item.id, kind: "folder" });
        }
        // web links are ignored — not relevant to a media library
      }

      const total = page.totalCount ?? entries.length;
      offset += page.entries?.length ?? 0;
      if (offset >= total || !page.entries?.length || entries.length >= MAX_ENTRIES) {
        break;
      }
    }

    return entries;
  });
}

/** Used by a single-title resync to re-derive the current name/tags directly from Box, so a rename or an added/edited {tmdb-...}/{edition-...} tag is picked up without a full library rescan. */
async function getFolder(serverId: string, folderId: string): Promise<StorageEntry | null> {
  return withBoxClient(serverId, async (client) => {
    try {
      const folder = await client.folders.getFolderById(folderId, {
        queryParams: { fields: ["name"] },
      });
      return { id: folder.id, name: folder.name ?? folder.id, kind: "folder" };
    } catch (err) {
      if (err instanceof BoxApiError && err.responseInfo?.statusCode === 404) return null;
      throw err;
    }
  });
}

// Short-lived cache so probing one file's MP4 duration (several small
// byte-range reads per file — see mp4-duration.ts) doesn't mint a brand
// new downscoped Box token + download URL for every single range request.
const STREAMING_URL_CACHE = new Map<string, StreamingUrl>();
const REUSE_MARGIN_MS = 15_000; // don't hand out a URL expiring this soon

async function mintDownloadUrl(serverId: string, fileId: string): Promise<StreamingUrl> {
  return withBoxClient(serverId, async (client) => {
    // Downscope to read-only access on this one file, so if the resulting
    // streaming URL ever leaked, the blast radius is that one file, not
    // the server's whole connected Box account.
    const resource = `https://api.box.com/2.0/files/${fileId}`;
    await ensureFreshAccessToken(client);
    const scopedToken = await client.auth.downscopeToken(["item_download"], resource);
    if (!scopedToken.accessToken) {
      throw new Error(`Box: failed to downscope token for file ${fileId}`);
    }
    const scopedClient = new BoxClient({
      auth: new BoxDeveloperTokenAuth({ token: scopedToken.accessToken }),
    });
    const url = await scopedClient.downloads.getDownloadFileUrl(fileId);
    const expiresAt = new Date(Date.now() + (scopedToken.expiresIn ?? 60) * 1000);
    return { url, expiresAt };
  });
}

async function getStreamingUrl(serverId: string, fileId: string): Promise<StreamingUrl> {
  const cacheKey = `${serverId}:${fileId}`;
  const cached = STREAMING_URL_CACHE.get(cacheKey);
  if (cached && cached.expiresAt.getTime() - Date.now() > REUSE_MARGIN_MS) {
    return cached;
  }

  const result = await mintDownloadUrl(serverId, fileId);
  STREAMING_URL_CACHE.set(cacheKey, result);
  return result;
}

/**
 * A download URL minted right now, bypassing the reuse cache. For a job
 * that is about to download the whole file and can't tolerate a URL that
 * only has seconds left.
 */
export function getFreshDownloadUrl(serverId: string, fileId: string): Promise<StreamingUrl> {
  return mintDownloadUrl(serverId, fileId);
}

/**
 * A short-lived token that can upload into ONE folder and nothing else, so
 * a remux job (or a compromised sandbox) can't touch the rest of the
 * server's connected Box account.
 */
export async function mintUploadToken(
  serverId: string,
  folderId: string
): Promise<{ accessToken: string; expiresAt: Date }> {
  return withBoxClient(serverId, async (client) => {
    const resource = `https://api.box.com/2.0/folders/${folderId}`;
    await ensureFreshAccessToken(client);
    const scopedToken = await client.auth.downscopeToken(["item_upload"], resource);
    if (!scopedToken.accessToken) {
      throw new Error(`Box: failed to downscope upload token for folder ${folderId}`);
    }
    return {
      accessToken: scopedToken.accessToken,
      expiresAt: new Date(Date.now() + (scopedToken.expiresIn ?? 60) * 1000),
    };
  });
}

/** A file's current name and size straight from Box, or null if it no longer exists. */
export async function getBoxFileEntry(serverId: string, fileId: string): Promise<StorageEntry | null> {
  return withBoxClient(serverId, async (client) => {
    try {
      const file = await client.files.getFileById(fileId, { queryParams: { fields: ["name", "size"] } });
      return { id: file.id, name: file.name ?? file.id, kind: "file", sizeBytes: file.size };
    } catch (err) {
      if (err instanceof BoxApiError && err.responseInfo?.statusCode === 404) return null;
      throw err;
    }
  });
}

async function fetchByteRange(
  serverId: string,
  fileId: string,
  startByte: number,
  endByte: number
): Promise<ArrayBuffer> {
  // Reuse the same pre-authenticated download URL path the browser will
  // eventually use, so the probe exercises the real range-request behavior.
  const { url } = await getStreamingUrl(serverId, fileId);
  const res = await fetch(url, {
    headers: { Range: `bytes=${startByte}-${endByte}` },
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(
      `Box: byte-range fetch failed for file ${fileId} (${res.status})`
    );
  }
  return res.arrayBuffer();
}

export function createBoxProviderForServer(serverId: string): StorageProvider {
  return {
    listFolder: (folderId) => listFolder(serverId, folderId),
    getFolder: (folderId) => getFolder(serverId, folderId),
    getStreamingUrl: (fileId) => getStreamingUrl(serverId, fileId),
    fetchByteRange: (fileId, startByte, endByte) =>
      fetchByteRange(serverId, fileId, startByte, endByte),
  };
}

/** Renames a Box file or folder in place (its id, and so everything keyed on it, is unchanged). */
export async function renameBoxEntry(
  serverId: string,
  kind: "file" | "folder",
  id: string,
  name: string
): Promise<void> {
  await withBoxClient(serverId, async (client) => {
    if (kind === "folder") await client.folders.updateFolderById(id, { requestBody: { name } });
    else await client.files.updateFileById(id, { requestBody: { name } });
  });
}
