/** A rating is kept in half stars, 1 to 10 (7 is three and a half stars). */
export const MAX_HALF_STARS = 10;

export const isHalfStars = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_HALF_STARS;

/** The average of a few ratings, shown to the nearest half star. */
export const nearestHalf = (avg: number): number => Math.min(MAX_HALF_STARS, Math.max(1, Math.round(avg)));

/** "3.5", "4", from half stars. */
export const starsText = (half: number): string => (half / 2).toFixed(half % 2 ? 1 : 0);

/** "★★★½" for words and small spaces. */
export const starsGlyphs = (half: number): string => "★".repeat(Math.floor(half / 2)) + (half % 2 ? "½" : "");
