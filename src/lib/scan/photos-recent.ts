/**
 * A quick look for new pictures and videos in a photo library, from the newest forward, without walking the whole library. Opening a library
 * (or pulling down on it) runs this so what was just added shows up in seconds instead of waiting for the next full scan.
 *
 * Where new things turn up, in a library organised in folders: in the folder the newest items already sit in, in a folder beside or above it
 * (a new month, a new day), or in a folder that did not exist before. So it lists the library's top, follows the path down to each of the
 * folders the newest items are in (a handful of listings), and walks any folder it finds that the library has not seen, in full. Everything it
 * writes is what a full scan writes (same code), so it can run at any time, even beside a full scan. Photos added to an old folder that no
 * recent item is in are left for the full scan.
 */
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { libraries, titles } from "@/lib/db/schema";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";
import { libraryRootIds } from "@/lib/libraries/sources";
import { treeProfileFor } from "@/lib/scan/tree-profile";
import { StorageReauthRequiredError } from "@/lib/storage/reauth";
import { createStorageForServer } from "@/lib/storage/server-storage";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import { libraryPath, probeVideoLibrary, syncVideoDirectory } from "@/lib/scan/video-library";
import { walkVideoTree } from "@/lib/scan/video-walk";
import { CONTENTION_CODES, retryOnContention } from "@/lib/playlists/retry";

/** How many of the newest items' folders are looked into. */
const RECENT_FOLDERS = 3;
/** The whole look must finish within this long (it runs while someone waits at the top of the page). */
export const RECENT_BUDGET_MS = 25_000;
const PROBE_MS = 10_000;
const LOCK_TIMEOUT = "55P03";

export interface RecentScanResult {
  /** New pictures and videos found. */
  added: number;
  errors: string[];
  /** Ran out of time before looking everywhere it meant to. */
  incomplete: boolean;
}

/** The segments of a library-relative folder path ("2026/10/17" -> ["2026", "10", "17"]; "" -> []). */
export const pathSegments = (folderPath: string | null): string[] => (folderPath ?? "").split("/").filter(Boolean);

export async function scanRecentPhotos(libraryId: string, now: () => number = Date.now): Promise<RecentScanResult> {
  const started = now();
  const out: RecentScanResult = { added: 0, errors: [], incomplete: false };
  const [library] = await db.select().from(libraries).where(eq(libraries.id, libraryId)).limit(1);
  if (!library || !isPhotoLibraryKind(library.kind)) throw new Error("That isn't a photo library.");
  const profile = treeProfileFor(library.kind as Parameters<typeof treeProfileFor>[0]);
  const provider = createStorageForServer(library.serverId);
  // Stamped with the library's current scan cycle, so a full scan finishing meanwhile counts these as seen.
  const cycleId = library.scanCycleId ?? null;
  const outOfTime = () => now() - started > RECENT_BUDGET_MS - PROBE_MS;

  // The folders the library already knows, by path: every folder with a picture in it, and every folder on the way down to one.
  const known = new Set<string>();
  for (const r of await db.selectDistinct({ path: titles.folderPath }).from(titles).where(eq(titles.libraryId, libraryId))) {
    const segments = pathSegments(r.path);
    for (let i = 1; i <= segments.length; i++) known.add(segments.slice(0, i).join("/"));
  }
  const recent = await db
    .select({ path: titles.folderPath, newest: sql<Date>`max(${titles.addedAt})` })
    .from(titles)
    .where(eq(titles.libraryId, libraryId))
    .groupBy(titles.folderPath)
    .orderBy(desc(sql`max(${titles.addedAt})`))
    .limit(RECENT_FOLDERS);

  const listings = new Map<string, Promise<StorageEntry[]>>();
  const list = (id: string) => {
    let p = listings.get(id);
    if (!p) listings.set(id, (p = provider.listFolder(id, { strict: true })));
    return p;
  };
  const synced = new Set<string>();
  const write = async (folderId: string, folderPath: string, entries: StorageEntry[]) => {
    if (synced.has(folderId)) return;
    synced.add(folderId);
    try {
      const r = await retryOnContention(() => syncVideoDirectory(libraryId, folderId, folderPath, entries, cycleId, profile), [...CONTENTION_CODES, LOCK_TIMEOUT]);
      out.added += r.added;
      if (r.conflicts > 0) out.errors.push(`${folderPath || "(top)"}: ${r.conflicts} file(s) belong to another library and were skipped.`);
    } catch (err) {
      if (err instanceof StorageReauthRequiredError) throw err;
      out.errors.push(`${folderPath || "(top)"}: ${(err as Error).message}`);
    }
  };

  // A folder nobody has seen: everything under it.
  const walked = new Set<string>();
  const walkNew = async (folder: StorageEntry, above: string[]) => {
    if (walked.has(folder.id)) return;
    walked.add(folder.id);
    for await (const dir of walkVideoTree(provider as Pick<StorageProvider, "listFolder">, folder, null)) {
      if (outOfTime()) {
        out.incomplete = true;
        return;
      }
      if (dir.error) {
        out.errors.push(`${[...above, folder.name, ...dir.namePath].join("/")}: couldn't be read (${dir.error}).`);
        continue;
      }
      await write(dir.idPath[dir.idPath.length - 1] ?? folder.id, libraryPath(null, [...above, folder.name, ...dir.namePath]), dir.entries);
    }
  };
  /** Looks at a listing's subfolders and walks the ones this library has not seen. */
  const discover = async (entries: StorageEntry[], above: string[]) => {
    for (const e of entries) if (e.kind === "folder" && !known.has(libraryPath(null, [...above, e.name])) && !outOfTime()) await walkNew(e, above);
  };

  try {
    const roots = await libraryRootIds(library);
    const top: { root: string; entries: StorageEntry[] }[] = [];
    for (const root of roots) {
      try {
        top.push({ root, entries: await list(root) });
      } catch (err) {
        if (err instanceof StorageReauthRequiredError || roots.length === 1) throw err;
        out.errors.push(`A library folder couldn't be read: ${(err as Error).message}`);
      }
    }
    for (const t of top) {
      await write(t.root, "", t.entries); // loose files at the top
      await discover(t.entries, []);
    }
    // Down to each of the folders the newest items are in, looking at every folder on the way.
    for (const r of recent) {
      const segments = pathSegments(r.path);
      let level = top.flatMap((t) => t.entries);
      const idPath: string[] = [];
      for (let i = 0; i < segments.length && !outOfTime(); i++) {
        const folder = level.find((e) => e.kind === "folder" && libraryPath(null, [e.name]) === segments[i]);
        if (!folder) break; // moved or removed: the full scan deals with it
        idPath.push(folder.id);
        const entries = await list(folder.id);
        await write(folder.id, libraryPath(null, segments.slice(0, i + 1)), entries);
        await discover(entries, segments.slice(0, i + 1));
        level = entries;
      }
    }
  } catch (err) {
    if (err instanceof StorageReauthRequiredError) out.errors.push("This server's storage connection needs to be reconnected by an admin.");
    else out.errors.push((err as Error).message);
  }

  // Read what the new pictures and videos hold (when each was taken, their size), within what time is left.
  try {
    const more = await probeVideoLibrary(provider as StorageProvider, libraryId, Math.min(now() + PROBE_MS, started + RECENT_BUDGET_MS), out.errors, profile);
    out.incomplete = out.incomplete || more;
  } catch (err) {
    out.errors.push((err as Error).message);
  }
  return out;
}
