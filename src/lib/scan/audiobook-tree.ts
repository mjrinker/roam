import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { StorageEntry, StorageProvider } from "@/lib/storage/provider";
import { isAudioFile, isDiscFolderName, isExtraFile, orderBookParts } from "@/lib/scan/conventions";
import { compareNames, sortForScan } from "@/lib/scan/cursor";

// Layout: <Author>/<Book (Year)>/files, optionally <Author>/<Series>/<Book>.
// A folder that directly holds audio files (or CD1/Disc 2/Part 3 subfolders
// that do) is one book; a folder that only holds other folders is an author
// or a series. This module only reads the Box tree; it never touches the DB.

const isBookAudio = (e: StorageEntry) => e.kind === "file" && isAudioFile(e.name) && !isExtraFile(e.name);

/**
 * The ordered audio files of the book in this folder, or null if it isn't a
 * book. Disc/part subfolders (CD1, Disc 2, Part 03…) are flattened into the
 * one book, ordered by disc then file; other subfolders (extras, bonus) are
 * ignored.
 */
export async function collectBookFiles(
  provider: Pick<StorageProvider, "listFolder">,
  children: StorageEntry[]
): Promise<StorageEntry[] | null> {
  const loose = children.filter(isBookAudio);
  const discGroups: { name: string; files: StorageEntry[] }[] = [];
  for (const disc of children.filter((c) => c.kind === "folder" && isDiscFolderName(c.name))) {
    const files = (await provider.listFolder(disc.id)).filter(isBookAudio);
    if (files.length > 0) discGroups.push({ name: disc.name, files });
  }
  if (loose.length === 0 && discGroups.length === 0) return null;
  return orderBookParts(loose, discGroups);
}

const nonDiscFolders = (children: StorageEntry[]) =>
  sortForScan(children.filter((c) => c.kind === "folder" && !isDiscFolderName(c.name)));

export interface DiscoveredBook {
  folder: StorageEntry;
  files: StorageEntry[];
  /** The author folder above the book; null when the book sits directly under the library root. */
  folderAuthor: string | null;
  seriesName: string | null;
}

/** One resumable step of an author folder: a book, or a series of books. */
export interface DiscoveredUnit {
  /** Name of the author-folder child this unit is (the sub-cursor value); null when the top folder is itself a book. */
  childName: string | null;
  books: DiscoveredBook[];
  /** Set when this unit couldn't be read; the walk carries on with the next one. */
  error?: string;
}

/**
 * Lazily walks one top-level folder, yielding a unit at a time so the caller
 * can check its time budget between units (Box listing happens on `next()`).
 * `afterSub` skips children at or before the sub-cursor.
 */
export async function* discoverAuthorUnits(
  provider: Pick<StorageProvider, "listFolder">,
  top: StorageEntry,
  afterSub: string | null
): AsyncGenerator<DiscoveredUnit> {
  const children = await provider.listFolder(top.id);

  const ownFiles = await collectBookFiles(provider, children);
  if (ownFiles) {
    yield { childName: null, books: [{ folder: top, files: ownFiles, folderAuthor: null, seriesName: null }] };
    return;
  }

  for (const child of nonDiscFolders(children)) {
    if (afterSub !== null && compareNames(child.name, afterSub) <= 0) continue;

    try {
      const childChildren = await provider.listFolder(child.id);
      const files = await collectBookFiles(provider, childChildren);
      if (files) {
        yield {
          childName: child.name,
          books: [{ folder: child, files, folderAuthor: top.name, seriesName: null }],
        };
        continue;
      }

      // Not a book: a series folder whose subfolders are the books.
      const books: DiscoveredBook[] = [];
      for (const bookFolder of nonDiscFolders(childChildren)) {
        const bookFiles = await collectBookFiles(provider, await provider.listFolder(bookFolder.id));
        if (bookFiles) {
          books.push({ folder: bookFolder, files: bookFiles, folderAuthor: top.name, seriesName: child.name });
        }
      }
      yield { childName: child.name, books };
    } catch (err) {
      // A dead Box connection would fail every book the same way; abort.
      if (err instanceof BoxReauthRequiredError) throw err;
      yield { childName: child.name, books: [], error: (err as Error).message };
    }
  }
}
