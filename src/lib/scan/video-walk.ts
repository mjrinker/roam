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
import { ListingTruncatedError, type StorageEntry, type StorageProvider } from "@/lib/storage/provider";
import { sortForScan } from "@/lib/scan/cursor";

export interface WalkedDir {
  /** Box folder ids from the top-level folder down to this directory (empty for the top-level folder itself). */
  idPath: string[];
  /** The matching folder names, for building the library-relative folder path. */
  namePath: string[];
  /** Everything directly inside it. */
  entries: StorageEntry[];
  /**
   * Set when this directory could not be listed (after retries): `entries` is empty and its
   * subfolders were NOT visited. The walk carries on with the siblings instead of abandoning the
   * rest of the tree; the caller reports the error and the next full scan tries it again.
   */
  error?: string;
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

/**
 * A lost Box connection affects every listing, so it stops the walk. Recognized by name, not class:
 * importing the class would pull the database client into this otherwise pure module.
 */
const isReauth = (err: unknown) => (err as { name?: string } | null)?.name === "BoxReauthRequiredError";

const LIST_ATTEMPTS = 3;
interface WalkOptions {
  /** Pause before a listing retry, times the attempt number. */
  retryDelayMs: number;
}

/** A strict listing, retried for transient failures; a folder too big to list, or a lost Box connection, is not retried. */
async function listStrict(provider: Provider, id: string, opts: WalkOptions): Promise<StorageEntry[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.listFolder(id, { strict: true });
    } catch (err) {
      if (isReauth(err) || err instanceof ListingTruncatedError || attempt >= LIST_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs * attempt));
    }
  }
}

async function* walk(
  provider: Provider,
  dir: StorageEntry,
  idPath: string[],
  namePath: string[],
  /** null: nothing in this subtree is done. []: this directory is done. [x, ...]: x's subtree holds the resume point. */
  remaining: string[] | null,
  opts: WalkOptions
): AsyncGenerator<WalkedDir> {
  let entries: StorageEntry[];
  try {
    entries = await listStrict(provider, dir.id, opts);
  } catch (err) {
    // Re-finding the resume point needs this listing, and a lost Box connection affects everything:
    // both stop the walk. Otherwise a directory that can't be listed is reported and skipped.
    if (remaining !== null || isReauth(err)) throw err;
    yield { idPath, namePath, entries: [], error: (err as Error).message };
    return;
  }
  const subs = sortForScan(entries.filter((e) => e.kind === "folder"));

  if (remaining === null) {
    yield { idPath, namePath, entries };
    for (const sub of subs) yield* walk(provider, sub, [...idPath, sub.id], [...namePath, sub.name], null, opts);
    return;
  }
  if (remaining.length === 0) {
    // This directory's own files are done; its subfolders are not.
    for (const sub of subs) yield* walk(provider, sub, [...idPath, sub.id], [...namePath, sub.name], null, opts);
    return;
  }
  const [next, ...rest] = remaining;
  const at = subs.findIndex((s) => s.id === next);
  if (at === -1) throw new ResumePointGone();
  // Earlier siblings are finished; descend into the one holding the resume point, then carry on after it.
  yield* walk(provider, subs[at], [...idPath, next], [...namePath, subs[at].name], rest, opts);
  for (const sub of subs.slice(at + 1)) yield* walk(provider, sub, [...idPath, sub.id], [...namePath, sub.name], null, opts);
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
  resume: string[] | null,
  options: Partial<WalkOptions> = {}
): AsyncGenerator<WalkedDir> {
  const opts: WalkOptions = { retryDelayMs: options.retryDelayMs ?? 300 };
  try {
    // Resuming only lists ancestors of the resume point and yields nothing until it has located
    // it, so a ResumePointGone can never arrive after some directories were already yielded.
    yield* walk(provider, top, [], [], resume, opts);
  } catch (err) {
    if (!(err instanceof ResumePointGone)) throw err;
    yield* walk(provider, top, [], [], null, opts);
  }
}
