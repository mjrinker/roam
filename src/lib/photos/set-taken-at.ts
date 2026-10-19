/**
 * Changing when a picture was taken, by hand. The date is saved in Roam at once (the timeline moves it, and no scan ever replaces it). Where
 * Roam can write to the picture's storage (Box) and the file is a JPEG, the date is also written into the file's own EXIF, saved as a new
 * VERSION of the Box file (same file, so nothing keyed on it changes, and Box keeps the earlier version in its history). Other formats and
 * other storage services are read-only to Roam, so there the date lives in Roam only; the result says which happened.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, titles } from "@/lib/db/schema";
import { setJpegTakenAt } from "@/lib/photos/exif-write";
import { uploadFile, type TokenProvider } from "@/lib/remux/remux-core.mjs";
import { createBoxProviderForServer, mintUploadToken } from "@/lib/storage/box";
import { boxParentFolderId } from "@/lib/storage/box-sidecar";
import { isOriginalBoxId } from "@/lib/storage/ids";

/** Photos bigger than this are not rewritten (the whole file is held in memory and sent back). */
export const MAX_REWRITE_BYTES = 60 * 1024 * 1024;

export type FileWrite = "written" | "not-box" | "not-jpeg" | "too-large" | "failed";
export interface SetTakenAtResult {
  takenAt: string;
  file: FileWrite;
}

/** The date typed in the form ("2015-06-01T08:30", no zone), as the wall-clock time Roam stores; null for anything else or a date in the future. */
export function parseTypedDate(value: unknown, now = Date.now()): Date | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  if (y < 1826 || date.getTime() > now + 24 * 60 * 60 * 1000) return null;
  return date;
}

export async function setPhotoTakenAt(serverId: string, titleId: string, takenAt: Date): Promise<SetTakenAtResult | null> {
  const [row] = await db
    .select({ id: titles.id, fileId: mediaFiles.boxFileId, filename: mediaFiles.filename, size: mediaFiles.sizeBytes, container: mediaFiles.container })
    .from(titles)
    .leftJoin(mediaFiles, and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titles.id), eq(mediaFiles.partIndex, 0)))
    .where(eq(titles.id, titleId))
    .limit(1);
  if (!row) return null;

  await db.update(titles).set({ takenAt, takenAtSource: "manual", updatedAt: new Date() }).where(eq(titles.id, titleId));
  const result = (file: FileWrite): SetTakenAtResult => ({ takenAt: takenAt.toISOString(), file });

  if (!row.fileId || !isOriginalBoxId(row.fileId)) return result("not-box");
  const jpeg = ["jpg", "jpeg"].includes((row.container ?? "").toLowerCase()) || /\.jpe?g$/i.test(row.filename ?? "");
  if (!jpeg) return result("not-jpeg");
  if (!row.size || row.size > MAX_REWRITE_BYTES) return result("too-large");

  let dir: string | null = null;
  try {
    const provider = createBoxProviderForServer(serverId);
    const { url } = await provider.getStreamingUrl(row.fileId);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const edited = setJpegTakenAt(bytes, takenAt);

    const folderId = await boxParentFolderId(serverId, row.fileId);
    let cached: { token: string; expiresAt: number } | null = null;
    const getToken: TokenProvider = async (force) => {
      if (force || !cached || cached.expiresAt - Date.now() < 60_000) {
        const t = await mintUploadToken(serverId, folderId);
        cached = { token: t.accessToken, expiresAt: t.expiresAt.getTime() };
      }
      return cached.token;
    };
    dir = await mkdtemp(join(tmpdir(), "roam-exif-"));
    const filePath = join(dir, "photo");
    await writeFile(filePath, edited);
    const done = await uploadFile({ getToken, folderId, name: row.filename ?? "photo.jpg", filePath, replaceFileId: row.fileId });
    if ("conflictId" in done) throw new Error("Box would not replace the file");
    // The file is the size it now is, so the next scan does not take it for a different picture.
    await db.update(mediaFiles).set({ sizeBytes: edited.length }).where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titleId), eq(mediaFiles.partIndex, 0)));
    return result("written");
  } catch (err) {
    console.error("writing a photo's date into its file:", err);
    return result("failed");
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
