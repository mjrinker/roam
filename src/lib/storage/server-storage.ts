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
  /**
   * Whether Roam may change the file (or folder) with this stored id: "ok", "read-only" when its connection hasn't been allowed to (the admin hasn't
   * turned editing on, or the sign-in wasn't given the write permission, or it needs signing in again), or "unsupported" when the storage can't.
   */
  writeAccess(storedId: string): Promise<WriteAccess>;
  /** The writes of StorageProvider, by stored id; each throws StorageWriteNotAllowedError unless writeAccess says "ok". */
  /** The whole of a file (reading needs no permission); throws when it is bigger than `maxBytes` or the storage can't. */
  readFile(storedId: string, maxBytes: number): Promise<Uint8Array>;
  replaceFile(storedId: string, bytes: Uint8Array): Promise<void>;
  createFile(parentStoredId: string, name: string, bytes: Uint8Array): Promise<{ id: string }>;
  renameEntry(kind: "file" | "folder", storedId: string, name: string): Promise<void>;
  parentFolderId(storedId: string): Promise<string>;
}

export type WriteAccess = "ok" | "read-only" | "unsupported";

export class StorageWriteNotAllowedError extends Error {
  constructor(public readonly access: Exclude<WriteAccess, "ok">) {
    super(access === "read-only" ? "This storage is read-only to Roam: an admin can allow editing in Server settings, under Storage." : "This storage can't be changed from Roam.");
    this.name = "StorageWriteNotAllowedError";
  }
}

/** Box is always editable (Roam has always held its full connection). The others only once an admin allowed it and the sign-in was given the write permission. */
export const connectionAllowsWrite = (c: Pick<StorageConnection, "provider" | "writeEnabled" | "writeGranted" | "authStatus">): boolean =>
  c.provider === "box" || (c.writeEnabled && c.writeGranted && c.authStatus === "connected");

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
  writeEnabled: false,
  writeGranted: false,
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

  /** The provider and its own id for something to change, after checking that its connection allows it and that the storage can. */
  async function writable(storedId: string, method: "replaceFile" | "createFile" | "renameEntry" | "parentFolderId") {
    const r = await resolve(storedId);
    if (!connectionAllowsWrite(r.conn)) throw new StorageWriteNotAllowedError("read-only");
    if (!r.provider[method]) throw new StorageWriteNotAllowedError("unsupported");
    return r;
  }

  return {
    connectionOf: async (storedId) => connection(parseStorageId(serverId, storedId).connectionId),

    async writeAccess(storedId) {
      try {
        const { conn, provider } = await resolve(storedId);
        if (!provider.replaceFile) return "unsupported";
        return connectionAllowsWrite(conn) ? "ok" : "read-only";
      } catch {
        return "read-only";
      }
    },
    async readFile(storedId, maxBytes) {
      const { provider, nativeId } = await resolve(storedId);
      if (!provider.readFile) throw new StorageWriteNotAllowedError("unsupported");
      return provider.readFile(nativeId, maxBytes);
    },
    async replaceFile(storedId, bytes) {
      const { provider, nativeId } = await writable(storedId, "replaceFile");
      await provider.replaceFile!(nativeId, bytes);
    },
    async createFile(parentStoredId, name, bytes) {
      const { conn, provider, nativeId } = await writable(parentStoredId, "createFile");
      const made = await provider.createFile!(nativeId, name, bytes);
      return { id: stored(conn, made.id) };
    },
    async renameEntry(kind, storedId, name) {
      const { provider, nativeId } = await writable(storedId, "renameEntry");
      await provider.renameEntry!(kind, nativeId, name);
    },
    async parentFolderId(storedId) {
      const { conn, provider, nativeId } = await writable(storedId, "parentFolderId");
      return stored(conn, await provider.parentFolderId!(nativeId));
    },

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
