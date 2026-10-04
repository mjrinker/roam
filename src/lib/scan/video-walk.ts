/**
 * Walking a video library's folder tree in a fixed order, resumably. A scan pass has a time budget,
 * so it may stop partway through a top-level folder; the cursor's `sub` then records the last
 * directory COMPLETED, as the Box folder ids from the top-level folder down (ids are exact; names
 * can collide or normalize differently). The next pass re-lists only the ancestors of that
 * directory to find where to carry on, instead of re-walking everything before it.
 *
 * Order is pre-order depth-first with sorted siblings (the scanner's one comparator): a directory,
 * then its subfolders in order. Every listing is strict, so a truncated listing aborts the walk
 * rather than looking like a smaller folder.
 */
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import { sortForScan } from "@/lib/scan/cursor";

export interface WalkedDir {
  /** Box folder ids from the top-level folder down to this directory (empty for the top-level folder itself). */
  idPath: string[];
  /** The matching folder names, for building the library-relative folder path. */
  namePath: string[];
  /** Everything directly inside it. */
  entries: StorageEntry[];
}

/** Cursor `sub` for "this directory was the last one completed". Always truthy, so progress counting still works. */
export function encodeSub(idPath: string[]): string {
  return "/" + idPath.join("/");
}

/** Inverse of encodeSub; null when `sub` isn't one. */
export function decodeSub(sub: string | undefined | null): string[] | null {
  if (!sub || !sub.startsWith("/")) return null;
  const rest = sub.slice(1);
  return rest === "" ? [] : rest.split("/");
}

class ResumePointGone extends Error {}

type Provider = Pick<StorageProvider, "listFolder">;

async function* walk(
  provider: Provider,
  dir: StorageEntry,
  idPath: string[],
  namePath: string[],
  /** null: nothing in this subtree is done. []: this directory is done. [x, ...]: x's subtree holds the resume point. */
  remaining: string[] | null
): AsyncGenerator<WalkedDir> {
  const entries = await provider.listFolder(dir.id, { strict: true });
  const subs = sortForScan(entries.filter((e) => e.kind === "folder"));

  if (remaining === null) {
    yield { idPath, namePath, entries };
    for (const sub of subs) yield* walk(provider, sub, [...idPath, sub.id], [...namePath, sub.name], null);
    return;
  }
  if (remaining.length === 0) {
    // This directory's own files are done; its subfolders are not.
    for (const sub of subs) yield* walk(provider, sub, [...idPath, sub.id], [...namePath, sub.name], null);
    return;
  }
  const [next, ...rest] = remaining;
  const at = subs.findIndex((s) => s.id === next);
  if (at === -1) throw new ResumePointGone();
  // Earlier siblings are finished; descend into the one holding the resume point, then carry on after it.
  yield* walk(provider, subs[at], [...idPath, next], [...namePath, subs[at].name], rest);
  for (const sub of subs.slice(at + 1)) yield* walk(provider, sub, [...idPath, sub.id], [...namePath, sub.name], null);
}

/**
 * Every directory under `top` (itself included) still to process, in order. `resume` is the decoded
 * cursor `sub` (or null to start at the beginning). If the resume point no longer exists (a folder
 * was moved or deleted between passes) the folder is simply walked again from its start: everything
 * the scanner does per directory is idempotent.
 */
export async function* walkVideoTree(
  provider: Provider,
  top: StorageEntry,
  resume: string[] | null
): AsyncGenerator<WalkedDir> {
  try {
    // Resuming only lists ancestors of the resume point and yields nothing until it has located
    // it, so a ResumePointGone can never arrive after some directories were already yielded.
    yield* walk(provider, top, [], [], resume);
  } catch (err) {
    if (!(err instanceof ResumePointGone)) throw err;
    yield* walk(provider, top, [], [], null);
  }
}
