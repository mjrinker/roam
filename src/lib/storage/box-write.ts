/**
 * Box's side of the write operations in StorageProvider (replace a file's contents, save a file in a folder, rename, find a folder). Roam holds
 * the server's full Box connection, but each upload mints a token that can upload into that one folder and nothing else. A replaced file becomes
 * a new VERSION of the same Box file (its id and place are kept, and Box keeps the earlier version).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadFile, type TokenProvider } from "@/lib/remux/remux-core.mjs";
import { createBoxProviderForServer, mintUploadToken, renameBoxEntry } from "@/lib/storage/box";
import { readWhole } from "@/lib/storage/http";
import { withBoxClient } from "@/lib/storage/box-token-storage";
import type { StorageProvider } from "@/lib/storage/provider";

/** The folder a Box file is in. */
export async function boxParentFolderId(serverId: string, fileId: string): Promise<string> {
  return withBoxClient(serverId, async (client) => {
    const file = await client.files.getFileById(fileId, { queryParams: { fields: ["parent"] } });
    const id = file.parent?.id;
    if (!id) throw new Error("Box didn't say which folder this file is in.");
    return id;
  });
}

async function save(serverId: string, folderId: string, name: string, bytes: Uint8Array, replaceFileId?: string): Promise<{ id: string }> {
  let cached: { token: string; expiresAt: number } | null = null;
  const getToken: TokenProvider = async (force) => {
    if (force || !cached || cached.expiresAt - Date.now() < 60_000) {
      const t = await mintUploadToken(serverId, folderId);
      cached = { token: t.accessToken, expiresAt: t.expiresAt.getTime() };
    }
    return cached.token;
  };
  const dir = await mkdtemp(join(tmpdir(), "roam-write-"));
  try {
    const filePath = join(dir, "file");
    await writeFile(filePath, bytes);
    const first = await uploadFile({ getToken, folderId, name, filePath, replaceFileId });
    // The name is taken (an earlier copy of this file): save the bytes as its next version, so the file keeps its place.
    const done = "conflictId" in first ? await uploadFile({ getToken, folderId, name, filePath, replaceFileId: first.conflictId }) : first;
    if ("conflictId" in done) throw new Error("Box would not replace the existing file.");
    return { id: done.id };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function boxWriteMethods(serverId: string): Pick<StorageProvider, "readFile" | "replaceFile" | "createFile" | "renameEntry" | "parentFolderId"> {
  return {
    readFile: async (fileId, maxBytes) => readWhole(await fetch((await createBoxProviderForServer(serverId).getStreamingUrl(fileId)).url), maxBytes),
    async replaceFile(fileId, bytes) {
      const folderId = await boxParentFolderId(serverId, fileId);
      const name = await withBoxClient(serverId, async (client) => (await client.files.getFileById(fileId, { queryParams: { fields: ["name"] } })).name ?? "file");
      await save(serverId, folderId, name, bytes, fileId);
    },
    createFile: (parentFolderId, name, bytes) => save(serverId, parentFolderId, name, bytes),
    renameEntry: (kind, id, name) => renameBoxEntry(serverId, kind, id, name),
    parentFolderId: (fileId) => boxParentFolderId(serverId, fileId),
  };
}
