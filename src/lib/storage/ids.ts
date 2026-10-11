/**
 * Stored file and folder ids are opaque strings that mean something only to a storage connection. A server can have several connections,
 * so an id says which one it belongs to: ids from a server's original Box connection carry nothing extra (they were stored before there
 * could be more than one, and that connection's id is the server's own id), every other connection's ids are written
 * "cn_<connection id>:<the provider's id>". Nothing but this file and the storage router needs to know the shape.
 */

const PREFIXED = /^cn_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([\s\S]*)$/;

/** The id to store for something a connection reported. `serverId` is the server the connection belongs to. */
export function formatStorageId(serverId: string, connectionId: string, nativeId: string): string {
  return connectionId === serverId ? nativeId : `cn_${connectionId}:${nativeId}`;
}

/** Which connection a stored id belongs to, and the provider's own id for it. */
export function parseStorageId(serverId: string, storedId: string): { connectionId: string; nativeId: string } {
  const m = PREFIXED.exec(storedId);
  return m ? { connectionId: m[1], nativeId: m[2] } : { connectionId: serverId, nativeId: storedId };
}

/** True for an id from the server's original Box connection (the only ones Box-only features such as remuxing can act on). */
export const isOriginalBoxId = (storedId: string): boolean => !PREFIXED.test(storedId);
