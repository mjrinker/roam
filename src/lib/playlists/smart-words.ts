/** A smart playlist's rules in plain words (for its page), and the choices the form offers. Pure, so it can be tested. */
import type { SmartRules } from "@/lib/playlists/smart";
import { starsText } from "@/lib/ratings/stars";

/** The most a smart playlist may hold. */
export const SMART_MAX_LIMIT = 200;

export const MEDIA_WORDS: Record<SmartRules["media"], { label: string; noun: string }> = {
  movies: { label: "Movies", noun: "movies" },
  shows: { label: "TV shows", noun: "shows" },
  episodes: { label: "TV episodes", noun: "episodes" },
  songs: { label: "Songs", noun: "songs" },
  audiobooks: { label: "Audiobooks", noun: "audiobooks" },
};

export const SORT_WORDS: Record<SmartRules["sort"], string> = {
  title: "A to Z",
  newest: "newest release first",
  oldest: "oldest release first",
  added: "recently added first",
  rating: "my highest rated first",
  random: "in a random order",
};

export const WATCHED_WORDS: Record<SmartRules["watched"], string> = { any: "Watched or not", unwatched: "Not watched yet", inProgress: "Partly watched", watched: "Already watched" };

const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`);
const stars = (half: number) => `${starsText(half)} ${half === 2 ? "star" : "stars"}`;

/** "Unwatched comedy or drama movies, rated 4 stars and up, from 1990 to 1999, added in the last 30 days, my highest rated first, up to 50". */
export function describeRules(r: SmartRules): string {
  const parts: string[] = [];
  const state = r.watched === "unwatched" ? "Unwatched" : r.watched === "inProgress" ? "Partly watched" : r.watched === "watched" ? "Watched" : "All";
  const genres = r.genres.length ? ` ${r.genres.join(" or ")}` : "";
  parts.push(`${state}${genres} ${MEDIA_WORDS[r.media].noun}`.replace(/^All /, "All ").replace(/^Unwatched /, "Unwatched "));
  if (r.rated === "unrated") parts.push("that I haven't rated");
  else if (r.minStars !== null && r.maxStars !== null) parts.push(`rated ${stars(r.minStars)} to ${stars(r.maxStars)}`);
  else if (r.minStars !== null) parts.push(`rated ${stars(r.minStars)} and up`);
  else if (r.maxStars !== null) parts.push(`rated ${stars(r.maxStars)} or less`);
  else if (r.rated === "rated") parts.push("that I've rated");
  if (r.yearFrom !== null && r.yearTo !== null) parts.push(`from ${r.yearFrom} to ${r.yearTo}`);
  else if (r.yearFrom !== null) parts.push(`from ${r.yearFrom} on`);
  else if (r.yearTo !== null) parts.push(`up to ${r.yearTo}`);
  if (r.addedWithinDays !== null) parts.push(`added in the last ${r.addedWithinDays === 1 ? "day" : `${r.addedWithinDays} days`}`);
  if (r.media !== "shows") {
    if (r.minMinutes !== null && r.maxMinutes !== null) parts.push(`${minutes(r.minMinutes)} to ${minutes(r.maxMinutes)} long`);
    else if (r.minMinutes !== null) parts.push(`at least ${minutes(r.minMinutes)} long`);
    else if (r.maxMinutes !== null) parts.push(`${minutes(r.maxMinutes)} or shorter`);
  }
  return `${parts.join(", ")}; ${SORT_WORDS[r.sort]}, up to ${r.limit}.`;
}

// ── The form: which conditions have been added ──
export type Condition = "watched" | "genres" | "rating" | "years" | "added" | "duration";
export const CONDITIONS: { key: Condition; label: string }[] = [
  { key: "watched", label: "Watched" },
  { key: "genres", label: "Genres" },
  { key: "rating", label: "My rating" },
  { key: "years", label: "Release year" },
  { key: "added", label: "Added recently" },
  { key: "duration", label: "Duration" },
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
};

