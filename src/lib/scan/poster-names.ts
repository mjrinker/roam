/** Which picture beside a movie or show is its poster, by Plex's names (see local-artwork). Pure. */
import type { StorageEntry } from "@/lib/storage/provider";

export const POSTER_EXTENSIONS = new Set(["jpg", "jpeg", "png", "tbn"]);

export const MOVIE_POSTER_NAMES = ["poster", "cover", "folder", "movie", "default"];
export const SHOW_POSTER_NAMES = ["poster", "folder", "show"];

export const stem = (name: string) => name.replace(/\.[^.]+$/, "");
export const extOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

/**
 * The poster among a folder's files: a picture with one of the names (more than one can be kept, "poster-2.png"; the plain name wins, else the
 * first numbered), or one named like a video in the same listing ("Avatar (2009).jpg", "Avatar (2009)-1.jpg").
 */
export function posterFile(entries: StorageEntry[], names: string[], videoStems: string[] = []): StorageEntry | null {
  const images = entries.filter((e) => e.kind === "file" && POSTER_EXTENSIONS.has(extOf(e.name)));
  const numbered = (s: string) => /^(.*?)-\d+$/.exec(s)?.[1] ?? null;
  for (const wanted of names) {
    const exact = images.find((e) => stem(e.name).toLowerCase() === wanted);
    if (exact) return exact;
  }
  for (const wanted of names) {
    const hit = images.filter((e) => numbered(stem(e.name).toLowerCase()) === wanted).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
    if (hit) return hit;
  }
  for (const video of videoStems.map((v) => v.toLowerCase())) {
    const hit = images.find((e) => stem(e.name).toLowerCase() === video) ?? images.filter((e) => numbered(stem(e.name).toLowerCase()) === video).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
    if (hit) return hit;
  }
  return null;
}

