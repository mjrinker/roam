/** A smart playlist's rules in plain words (for its page), and the choices the form offers. Pure, so it can be tested. */
import type { SmartRules } from "@/lib/playlists/smart";
import { starsText } from "@/lib/ratings/stars";

/** The most a smart playlist may hold. */
export const SMART_MAX_LIMIT = 200;

/** A library a smart playlist can draw from (as the form lists them). */
export interface SmartLibrary {
  id: string;
  name: string;
  kind: string;
}

/** What each kind of library holds, in a word. */
const NOUN_OF_KIND: Record<string, "movies" | "shows" | "songs" | "audiobooks"> = { movies: "movies", shows: "shows", music: "songs", audio: "songs", audiobooks: "audiobooks" };
const ALL_KINDS = ["movies", "shows", "music", "audio", "audiobooks"];

/** The kinds of thing the rules hold: from the libraries named (when they are known), else the kinds, else everything. */
export function nounsOf(r: SmartRules, libs?: readonly SmartLibrary[]): string[] {
  let kinds: string[] = r.kinds.length ? r.kinds : ALL_KINDS;
  if (r.libraryIds.length) {
    const chosen = (libs ?? []).filter((l) => r.libraryIds.includes(l.id)).map((l) => l.kind);
    if (chosen.length === 0) return ["titles"]; // libraries we can't see the names of
    kinds = chosen;
  }
  return [...new Set(kinds.map((k) => (k === "shows" && r.showsAs === "episodes" ? "episodes" : (NOUN_OF_KIND[k] ?? "titles"))))];
}

/** True when the rules hold only TV shows (which have no one length, so a duration means nothing). */
export const holdsOnlyShows = (r: SmartRules, libs?: readonly SmartLibrary[]): boolean => {
  const nouns = nounsOf(r, libs);
  return nouns.length === 1 && nouns[0] === "shows";
};

export const SORT_WORDS: Record<SmartRules["sort"], string> = {
  title: "A to Z",
  titleDesc: "Z to A",
  newest: "newest release first",
  oldest: "oldest release first",
  added: "recently added first",
  addedOldest: "longest in the library first",
  rating: "my highest rated first",
  ratingLowest: "my lowest rated first",
  longest: "longest first",
  shortest: "shortest first",
  watchedRecently: "most recently watched first",
  watchedLongAgo: "watched longest ago first",
  genre: "by genre, A to Z",
  imdb: "highest IMDb score first",
  rottenTomatoes: "highest Rotten Tomatoes score first",
  average: "highest rated on this server first",
  contentRating: "youngest rating first",
  quality: "highest picture quality first",
  random: "in a random order",
};

export const WATCHED_WORDS: Record<SmartRules["watched"], string> = { any: "Watched or not", unwatched: "Not watched yet", inProgress: "Partly watched", watched: "Already watched" };

/** The picture heights the form offers, in words. */
export const HEIGHT_WORDS: Record<number, string> = { 720: "HD (720p)", 1080: "Full HD (1080p)", 2160: "4K" };
/** The content rating limits the form offers: the age, in words. */
export const AGE_CHOICES: { value: number; label: string }[] = [
  { value: 0, label: "Everyone" },
  { value: 7, label: "Ages 7 and under" },
  { value: 10, label: "Ages 10 and under" },
  { value: 13, label: "Ages 13 and under" },
  { value: 16, label: "Ages 16 and under" },
];

const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`);
const stars = (half: number) => `${starsText(half)} ${half === 2 ? "star" : "stars"}`;

/** "Unwatched comedy or drama movies, rated 4 stars and up, from 1990 to 1999, added in the last 30 days, my highest rated first, up to 50". */
export function describeRules(r: SmartRules, libs?: readonly SmartLibrary[]): string {
  const parts: string[] = [];
  const state = r.watched === "unwatched" ? "Unwatched" : r.watched === "inProgress" ? "Partly watched" : r.watched === "watched" ? "Watched" : "All";
  const genres = r.genres.length ? ` ${r.genres.join(" or ")}` : "";
  const nouns = nounsOf(r, libs);
  const noun = nouns.length === 1 ? nouns[0] : "titles";
  const names = (libs ?? []).filter((l) => r.libraryIds.includes(l.id)).map((l) => l.name);
  const where = r.libraryIds.length === 0 ? "" : names.length === 0 ? "" : names.length <= 3 ? ` in ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`}` : ` in ${names.length} libraries`;
  parts.push(`${state}${genres} ${noun}${where}`);
  if (r.rated === "unrated") parts.push("that I haven't rated");
  else if (r.minStars !== null && r.maxStars !== null) parts.push(`rated ${stars(r.minStars)} to ${stars(r.maxStars)}`);
  else if (r.minStars !== null) parts.push(`rated ${stars(r.minStars)} and up`);
  else if (r.maxStars !== null) parts.push(`rated ${stars(r.maxStars)} or less`);
  else if (r.rated === "rated") parts.push("that I've rated");
  if (r.yearFrom !== null && r.yearTo !== null) parts.push(`from ${r.yearFrom} to ${r.yearTo}`);
  else if (r.yearFrom !== null) parts.push(`from ${r.yearFrom} on`);
  else if (r.yearTo !== null) parts.push(`up to ${r.yearTo}`);
  if (r.addedWithinDays !== null) parts.push(`added in the last ${r.addedWithinDays === 1 ? "day" : `${r.addedWithinDays} days`}`);
  if (!holdsOnlyShows(r, libs)) {
    if (r.minMinutes !== null && r.maxMinutes !== null) parts.push(`${minutes(r.minMinutes)} to ${minutes(r.maxMinutes)} long`);
    else if (r.minMinutes !== null) parts.push(`at least ${minutes(r.minMinutes)} long`);
    else if (r.maxMinutes !== null) parts.push(`${minutes(r.maxMinutes)} or shorter`);
  }
  if (r.titleContains) parts.push(`with “${r.titleContains}” in the name`);
  if (r.person) parts.push(`with ${r.person}`);
  if (r.maxAge !== null) parts.push(r.maxAge === 0 ? "for everyone" : `rated for ages up to ${r.maxAge}`);
  if (r.minImdb !== null) parts.push(`IMDb ${r.minImdb} or more`);
  if (r.minRottenTomatoes !== null) parts.push(`Rotten Tomatoes ${r.minRottenTomatoes}% or more`);
  if (r.minAverage !== null) parts.push(`rated ${stars(r.minAverage)} or more on this server`);
  if (r.minHeight !== null) parts.push(`${HEIGHT_WORDS[r.minHeight] ?? `${r.minHeight}p`} or better`);
  if (r.watchedWithinDays !== null) parts.push(`watched in the last ${r.watchedWithinDays === 1 ? "day" : `${r.watchedWithinDays} days`}`);
  if (r.notWatchedWithinDays !== null) parts.push(`not watched in the last ${r.notWatchedWithinDays === 1 ? "day" : `${r.notWatchedWithinDays} days`}`);
  return `${parts.join(", ")}; ${SORT_WORDS[r.sort]}, up to ${r.limit}.`;
}

// ── The form: which conditions have been added ──
export type Condition = "watched" | "genres" | "rating" | "years" | "added" | "duration" | "name" | "person" | "age" | "scores" | "average" | "quality" | "lastWatched";
export const CONDITIONS: { key: Condition; label: string }[] = [
  { key: "watched", label: "Watched" },
  { key: "genres", label: "Genres" },
  { key: "rating", label: "My rating" },
  { key: "years", label: "Release year" },
  { key: "added", label: "Added recently" },
  { key: "duration", label: "Duration" },
  { key: "name", label: "Name contains" },
  { key: "person", label: "Cast, director, artist or author" },
  { key: "age", label: "Content rating" },
  { key: "scores", label: "IMDb or Rotten Tomatoes score" },
  { key: "average", label: "Rating on this server" },
  { key: "quality", label: "Picture quality" },
  { key: "lastWatched", label: "When I last watched" },
];

/** The conditions a set of rules already uses (so editing shows them), in the order they are offered. */
export function activeConditions(r: SmartRules): Condition[] {
  const on: Condition[] = [];
  if (r.watched !== "any") on.push("watched");
  if (r.genres.length > 0) on.push("genres");
  if (r.minStars !== null || r.maxStars !== null || r.rated !== "any") on.push("rating");
  if (r.yearFrom !== null || r.yearTo !== null) on.push("years");
  if (r.addedWithinDays !== null) on.push("added");
  if (r.minMinutes !== null || r.maxMinutes !== null) on.push("duration");
  if (r.titleContains) on.push("name");
  if (r.person) on.push("person");
  if (r.maxAge !== null) on.push("age");
  if (r.minImdb !== null || r.minRottenTomatoes !== null) on.push("scores");
  if (r.minAverage !== null) on.push("average");
  if (r.minHeight !== null) on.push("quality");
  if (r.watchedWithinDays !== null || r.notWatchedWithinDays !== null) on.push("lastWatched");
  return on;
}

/** What taking a condition away puts back. */
export const CLEARED: Record<Condition, Partial<SmartRules>> = {
  watched: { watched: "any" },
  genres: { genres: [] },
  rating: { minStars: null, maxStars: null, rated: "any" },
  years: { yearFrom: null, yearTo: null },
  added: { addedWithinDays: null },
  duration: { minMinutes: null, maxMinutes: null },
  name: { titleContains: null },
  person: { person: null },
  age: { maxAge: null },
  scores: { minImdb: null, minRottenTomatoes: null },
  average: { minAverage: null },
  quality: { minHeight: null },
  lastWatched: { watchedWithinDays: null, notWatchedWithinDays: null },
};

