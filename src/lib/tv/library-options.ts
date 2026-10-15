/** How a library list is sorted and narrowed (on a TV, and in the API): the options live in the address, and anything unknown falls back to the default. */
export const LIBRARY_SORTS = ["title", "year", "added"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export interface LibraryOptions {
  sort: LibrarySort;
  /** One genre, or null for all. */
  genre: string | null;
  /** Only what this profile hasn't finished. */
  unwatched: boolean;
  /** An account id (what that household owns), "none" (what nobody owns), or null for everything. */
  owner: string | null;
}

export const DEFAULT_OPTIONS: LibraryOptions = { sort: "title", genre: null, unwatched: false, owner: null };

export const SORT_WORDS: Record<LibrarySort, string> = { title: "Title", year: "Newest year first", added: "Recently added" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLibraryOptions(params: { get(name: string): string | null }): LibraryOptions {
  const sort = params.get("sort");
  const genre = (params.get("genre") ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60);
  const owner = params.get("owner");
  return {
    sort: (LIBRARY_SORTS as readonly string[]).includes(sort ?? "") ? (sort as LibrarySort) : "title",
    genre: genre || null,
    unwatched: params.get("unwatched") === "1",
    owner: owner === "none" || (owner && UUID.test(owner)) ? owner : null,
  };
}

/** The options as address parameters (defaults left out), plus anything extra. */
export function optionsQuery(o: LibraryOptions, extra: Record<string, string | number | null | undefined> = {}): string {
  const q = new URLSearchParams();
  if (o.sort !== "title") q.set("sort", o.sort);
  if (o.genre) q.set("genre", o.genre);
  if (o.unwatched) q.set("unwatched", "1");
  if (o.owner) q.set("owner", o.owner);
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== "") q.set(k, String(v));
  const text = q.toString();
  return text ? `?${text}` : "";
}

export const nextSort = (s: LibrarySort): LibrarySort => LIBRARY_SORTS[(LIBRARY_SORTS.indexOf(s) + 1) % LIBRARY_SORTS.length];

export const LETTERS = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")] as const;
/** A letter from an address: one capital letter or "#", else null. */
export const parseLetter = (v: string | null): string | null => (v && /^([A-Za-z]|#)$/.test(v) ? v.toUpperCase() : null);
