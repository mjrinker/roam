/**
 * Box helpers shared by the demo seeding scripts: find-or-create nested folders, and upload a file only if the
 * folder doesn't already hold one by that name (so every script can be re-run safely). They write to the Box account
 * connected to the given Roam server, and only ever create folders and new files.
 */
import { BoxApiError } from "box-node-sdk";
import { createBoxProviderForServer } from "@/lib/storage/box";
import { withBoxClient } from "@/lib/storage/box-token-storage";
import { uploadFile } from "@/lib/remux/remux-core.mjs";
import { uploadTokenProvider } from "@/lib/remux/tier1";

/** The id of the folder called `name` inside `parentId`, creating it if it isn't there. */
export async function ensureFolder(serverId: string, parentId: string, name: string): Promise<string> {
  const provider = createBoxProviderForServer(serverId);
  const existing = (await provider.listFolder(parentId)).find((e) => e.kind === "folder" && e.name === name);
  if (existing) return existing.id;
  try {
    return await withBoxClient(serverId, async (client) => (await client.folders.createFolder({ name, parent: { id: parentId } })).id);
  } catch (err) {
    // Created by something else between the listing and now.
    if (err instanceof BoxApiError && err.responseInfo?.statusCode === 409) {
      const again = (await provider.listFolder(parentId)).find((e) => e.kind === "folder" && e.name === name);
      if (again) return again.id;
    }
    throw err;
  }
}

/** Walks (creating as needed) `parts` below `rootId`, remembering folders it has seen in `cache`. */
export async function ensurePath(serverId: string, rootId: string, parts: string[], cache: Map<string, string>): Promise<string> {
  let parent = rootId;
  let key = rootId;
  for (const part of parts) {
    key = `${key}/${part}`;
    if (!cache.has(key)) cache.set(key, await ensureFolder(serverId, parent, part));
    parent = cache.get(key)!;
  }
  return parent;
}

export async function fileExists(serverId: string, folderId: string, name: string): Promise<boolean> {
  return (await createBoxProviderForServer(serverId).listFolder(folderId)).some((e) => e.kind === "file" && e.name === name);
}

/** Uploads `filePath` as `name` into `folderId` unless a file of that name is already there. */
export async function uploadIfNew(
  serverId: string,
  folderId: string,
  name: string,
  filePath: string,
  opts: { contentCreatedAt?: string } = {}
): Promise<"uploaded" | "exists"> {
  const result = await uploadFile({ getToken: uploadTokenProvider(serverId, folderId), folderId, name, filePath, contentCreatedAt: opts.contentCreatedAt });
  return "conflictId" in result ? "exists" : "uploaded";
}
