/**
 * The kinds of extra a movie can have and how Plex names them (support.plex.tv/articles/local-files-for-trailers-and-extras):
 * a file in the movie's folder named "<Name>-trailer.mp4" (the type is the suffix right before the extension), or any video inside a
 * subfolder of the movie's folder named for the type ("Trailers", "Behind The Scenes", "Deleted Scenes", "Featurettes", "Interviews",
 * "Scenes", "Shorts", "Other"). Pure; shared by the scanner and the pages.
 */

export const EXTRA_CATEGORIES = ["trailers", "behindthescenes", "deleted", "featurettes", "interviews", "scenes", "shorts", "other"] as const;
export type ExtraCategory = (typeof EXTRA_CATEGORIES)[number];

/** Section headings on a movie's page, in the order they are shown. */
export const EXTRA_LABELS: Record<ExtraCategory, string> = {
  trailers: "Trailers",
  behindthescenes: "Behind the scenes",
  deleted: "Deleted scenes",
  featurettes: "Featurettes",
  interviews: "Interviews",
  scenes: "Scenes",
  shorts: "Shorts",
  other: "Other extras",
};

/** The file-name suffix (after a hyphen, before the extension) for each type. */
const SUFFIX_CATEGORY: Record<string, ExtraCategory> = {
  trailer: "trailers",
  behindthescenes: "behindthescenes",
  deleted: "deleted",
  featurette: "featurettes",
  interview: "interviews",
  scene: "scenes",
  short: "shorts",
  other: "other",
};
const SUFFIX_RE = new RegExp(`-(${Object.keys(SUFFIX_CATEGORY).join("|")})(\\.[^.]+)$`, "i");

/** Folder names (letters only, lower case, so spacing and capitals don't matter) and their types; singular and plural both count. */
const FOLDER_CATEGORY: Record<string, ExtraCategory> = {
  trailers: "trailers",
  trailer: "trailers",
  behindthescenes: "behindthescenes",
  deletedscenes: "deleted",
  deletedscene: "deleted",
  featurettes: "featurettes",
  featurette: "featurettes",
  interviews: "interviews",
  interview: "interviews",
  scenes: "scenes",
  scene: "scenes",
  shorts: "shorts",
  short: "shorts",
  other: "other",
  extras: "other",
};

/** The type a movie-folder FILE name says it is ("Teaser-trailer.mp4" -> trailers), or null for an ordinary file. */
export function extraCategoryOfFile(fileName: string): ExtraCategory | null {
  const m = SUFFIX_RE.exec(fileName);
  return m ? SUFFIX_CATEGORY[m[1].toLowerCase()] : null;
}

/** The type a SUBFOLDER name says its videos are ("Behind The Scenes" -> behindthescenes), or null for any other folder. */
export function extraCategoryOfFolder(folderName: string): ExtraCategory | null {
  return FOLDER_CATEGORY[folderName.toLowerCase().replace(/[^a-z]/g, "")] ?? null;
}

/** What to call an extra: its file name without the type suffix and extension ("Official Teaser-trailer.mp4" -> "Official Teaser"). */
export function extraDisplayName(fileName: string): string {
  const stripped = fileName.replace(SUFFIX_RE, "").replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return stripped || fileName;
}
