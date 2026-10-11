/**
 * One StorageProvider for a whole server, whatever mix of connections it has. Everything that reads or streams files asks this, passing
 * the ids it stored; it works out which connection each id belongs to (see ids.ts), calls that connection's provider with the
 * provider's own id, and writes the ids it returns back in stored form. The scanner, the player and the photo and book routes therefore
 * never know how many connections or what kinds there are.
 */
import { formatStorageId, parseStorageId } from "@/lib/storage/ids";
import type { StorageProvider } from "@/lib/storage/provider";
import { loadConnection, providerForConnection, type StorageConnection } from "@/lib/storage/registry";

export interface ServerStorage extends StorageProvider {
  /** The connection a stored id belongs to (null when it no longer exists or belongs to another server). */
  connectionOf(storedId: string): Promise<StorageConnection | null>;
}

const originalBoxConnection = (serverId: string): StorageConnection => ({
  id: serverId,
  serverId,
  provider: "box",
  label: "Box",
  accountName: null,
  accessTokenEncrypted: null,
  refreshTokenEncrypted: null,
  tokenExpiresAt: null,
  secretsEncrypted: null,
  config: null,
  authStatus: "disconnected",
  createdAt: new Date(0),
});

export function createStorageForServer(serverId: string): ServerStorage {
  const connections = new Map<string, Promise<StorageConnection | null>>();
  const providers = new Map<string, StorageProvider>();

  const connection = (connectionId: string): Promise<StorageConnection | null> => {
    let c = connections.get(connectionId);
    if (!c) {
      // Only this server's own connections: a stored id naming another server's connection is a stranger's, not ours.
      c = loadConnection(connectionId).then((row) => {
        if (row) return row.serverId === serverId ? row : null;
        // A server's original id with no row of its own is its Box connection from before connections existed (or before they were copied).
        return connectionId === serverId ? originalBoxConnection(serverId) : null;
      });
      connections.set(connectionId, c);
    }
    return c;
  };

  async function resolve(storedId: string): Promise<{ conn: StorageConnection; provider: StorageProvider; nativeId: string }> {
    const { connectionId, nativeId } = parseStorageId(serverId, storedId);
    const conn = await connection(connectionId);
    if (!conn) throw new Error(`No storage connection for "${storedId.slice(0, 60)}"`);
    let provider = providers.get(conn.id);
    if (!provider) {
      provider = providerForConnection(conn);
      providers.set(conn.id, provider);
    }
    return { conn, provider, nativeId };
  }
  const stored = (conn: StorageConnection, nativeId: string) => formatStorageId(serverId, conn.id, nativeId);

  return {
    connectionOf: async (storedId) => connection(parseStorageId(serverId, storedId).connectionId),

    async listFolder(folderId, opts) {
      const { conn, provider, nativeId } = await resolve(folderId);
      return (await provider.listFolder(nativeId, opts)).map((e) => ({ ...e, id: stored(conn, e.id) }));
    },
    async getFolder(folderId) {
      const { conn, provider, nativeId } = await resolve(folderId);
      const entry = await provider.getFolder(nativeId);
      return entry ? { ...entry, id: stored(conn, entry.id) } : null;
    },
    async getStreamingUrl(fileId) {
      const { provider, nativeId } = await resolve(fileId);
      return provider.getStreamingUrl(nativeId);
    },
    async getFreshDownloadUrl(fileId) {
      const { provider, nativeId } = await resolve(fileId);
      return (provider.getFreshDownloadUrl ?? provider.getStreamingUrl).call(provider, nativeId);
    },
    async fetchThumbnail(fileId) {
      const { provider, nativeId } = await resolve(fileId);
      return provider.fetchThumbnail ? provider.fetchThumbnail(nativeId) : null;
    },
    async fetchPreview(fileId, opts) {
      const { provider, nativeId } = await resolve(fileId);
      return provider.fetchPreview ? provider.fetchPreview(nativeId, opts) : null;
    },
    async getBrowserVideoUrl(fileId, opts) {
      const { provider, nativeId } = await resolve(fileId);
      return provider.getBrowserVideoUrl ? provider.getBrowserVideoUrl(nativeId, opts) : null;
    },
    async fileExists(fileId) {
      const { provider, nativeId } = await resolve(fileId);
      // Without a way to know, nothing is ever removed for being missing: say "can't tell", not "gone".
      if (!provider.fileExists) throw new Error("This storage can't say whether a file still exists");
      return provider.fileExists(nativeId);
    },
    async fetchByteRange(fileId, startByte, endByte) {
      const { provider, nativeId } = await resolve(fileId);
      return provider.fetchByteRange(nativeId, startByte, endByte);
    },
  };
}
