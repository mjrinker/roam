/**
 * Writes a small text file (a scene file, "Movie.mcf") into the folder a Box video is in, replacing the one already there. Roam holds the
 * server's full Box connection (the same one remuxing uses to save new versions), but each write mints a token that can upload into that
 * one folder and nothing else.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadFile, type TokenProvider } from "@/lib/remux/remux-core.mjs";
import { mintUploadToken } from "@/lib/storage/box";
import { withBoxClient } from "@/lib/storage/box-token-storage";

/** The folder a Box file is in. */
export async function boxParentFolderId(serverId: string, fileId: string): Promise<string> {
  return withBoxClient(serverId, async (client) => {
    const file = await client.files.getFileById(fileId, { queryParams: { fields: ["parent"] } });
    const id = file.parent?.id;
    if (!id) throw new Error("Box didn't say which folder this file is in.");
    return id;
  });
}

export async function writeBoxSidecar(serverId: string, videoFileId: string, name: string, text: string): Promise<{ id: string }> {
  const folderId = await boxParentFolderId(serverId, videoFileId);
  let cached: { token: string; expiresAt: number } | null = null;
  const getToken: TokenProvider = async (force) => {
    if (force || !cached || cached.expiresAt - Date.now() < 60_000) {
      const t = await mintUploadToken(serverId, folderId);
      cached = { token: t.accessToken, expiresAt: t.expiresAt.getTime() };
    }
    return cached.token;
  };
  const dir = await mkdtemp(join(tmpdir(), "roam-sidecar-"));
  try {
    const filePath = join(dir, "file");
    await writeFile(filePath, text, "utf8");
    const first = await uploadFile({ getToken, folderId, name, filePath });
    // The name is taken (an earlier version of this file): save the new text as its next version, so the file keeps its place.
    const done = "conflictId" in first ? await uploadFile({ getToken, folderId, name, filePath, replaceFileId: first.conflictId }) : first;
    if ("conflictId" in done) throw new Error("Box would not replace the existing file.");
    return { id: done.id };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
