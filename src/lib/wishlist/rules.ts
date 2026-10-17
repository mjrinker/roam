/** What can go on the shared wishlist, and the rules about it. Pure, so the form and the server agree. */

export const WISH_KINDS = ["movie", "show", "audiobook", "book", "album", "other"] as const;
export type WishKind = (typeof WISH_KINDS)[number];
export const WISH_KIND_LABEL: Record<WishKind, string> = { movie: "Movie", show: "TV show", audiobook: "Audiobook", book: "Book", album: "Album", other: "Other" };
/** The kinds TMDB can look up. */
export const TMDB_KINDS = ["movie", "show"] as const;

export const MAX_TITLE = 200;
export const MAX_CREATOR = 120;
export const MAX_NOTE = 500;
export const MAX_OVERVIEW = 1500;
/** The most open (not yet got) wishes a server can hold, and one household can have asked for. */
export const MAX_OPEN_WISHES = 500;
export const MAX_OPEN_PER_HOUSEHOLD = 100;

/** A title as it is compared to tell if something is already listed: no case, accents, punctuation or a leading "The". */
export function wishKey(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(the|a|an) (?=\S)/, "");
}

/** A TMDB picture address a person may attach (the only kind there is): https://image.tmdb.org/t/p/w500/abc.jpg. Anything else is dropped. */
export function cleanPosterUrl(url: unknown): string | null {
  return typeof url === "string" && /^https:\/\/image\.tmdb\.org\/t\/p\/(w185|w342|w500)\/[A-Za-z0-9_.-]{1,80}$/.test(url) ? url : null;
}

/** Text tidied (single spaces, trimmed, cut to length), or null when empty. */
export function tidy(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t ? [...t].slice(0, max).join("") : null;
}
