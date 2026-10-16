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
  return `${parts.join(", ")}; ${SORT_WORDS[r.sort]}, up to ${r.limit}.`;
}
