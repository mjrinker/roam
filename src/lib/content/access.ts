/**
 * Whether a profile may see/play a title, given its rating_ages (see
 * lib/content/ratings) and the profile's own restrictions. This is the one
 * place that decides "allowed or not" — every list query and every play/
 * detail route is expected to go through here (see enforcement.test.ts,
 * which checks that nothing bypasses it).
 */

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { countryFromLocale, type RatingAges } from "@/lib/content/ratings";

export { countryFromLocale as ratingCountry };

export interface AccessProfile {
  locale: string;
  maxAge: number | null;
  allowUnrated: boolean;
}

/** The age that applies to this profile: its own country, else US, else the catch-all ANY flag. */
export function effectiveAge(ages: RatingAges | null | undefined, country: string): number | null {
  if (!ages) return null;
  return ages[country] ?? ages.US ?? ages.ANY ?? null;
}

/** True if `profile` may see/play content with these rating_ages. */
export function isAllowed(profile: AccessProfile, ages: RatingAges | null | undefined): boolean {
  if (profile.maxAge === null) return true;
  const age = effectiveAge(ages, countryFromLocale(profile.locale));
  if (age === null) return profile.allowUnrated;
  return age <= profile.maxAge;
}

/**
 * A SQL condition on `rating_ages` for use in a `WHERE`, or `undefined` when
 * the profile has no limit (so callers can drop it from an `and()` entirely
 * rather than adding a no-op condition). Written directly against a jsonb
 * column so it works on any query that selects from `titles` — pass the
 * possibly-aliased column (e.g. `t.ratingAges` from a join).
 */
export function contentFilter(profile: AccessProfile, ratingAgesColumn: SQLWrapper): SQL | undefined {
  if (profile.maxAge === null) return undefined;
  const country = countryFromLocale(profile.locale);
  const age = sql`COALESCE((${ratingAgesColumn}->>${country})::int, (${ratingAgesColumn}->>'US')::int, (${ratingAgesColumn}->>'ANY')::int)`;
  return profile.allowUnrated
    ? sql`(${age} IS NULL OR ${age} <= ${profile.maxAge})`
    : sql`(${age} IS NOT NULL AND ${age} <= ${profile.maxAge})`;
}

/** The rating-limit choices shown in the profile editor, in order from most to least restrictive. */
export const RATING_LEVELS: { value: number | null; label: string }[] = [
  { value: 0, label: "Little kids (G / TV-Y)" },
  { value: 7, label: "Older kids (TV-Y7)" },
  { value: 10, label: "PG / TV-PG" },
  { value: 13, label: "PG-13 / TV-14" },
  { value: 17, label: "R / TV-MA" },
  { value: null, label: "No limit" },
];

export const RATING_LEVEL_VALUES = RATING_LEVELS.map((l) => l.value);
