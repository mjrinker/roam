/**
 * The age rating choices for a video library, and how a rating is stored. Plain data and functions
 * with no database imports, so the admin form (a client component) can use them.
 */

/** Minimum age that may see the library, or null for unrated. */
export type VideoRating = number | null;

export const VIDEO_RATING_OPTIONS: { value: VideoRating; label: string }[] = [
  { value: 0, label: "All ages" },
  { value: 7, label: "7 and up" },
  { value: 10, label: "10 and up" },
  { value: 13, label: "13 and up" },
  { value: 17, label: "17 and up" },
  { value: 18, label: "Adults only (18+)" },
  { value: null, label: "Unrated (each profile's own setting decides)" },
];

export function isVideoRating(value: unknown): value is VideoRating {
  return value === null || (typeof value === "number" && VIDEO_RATING_OPTIONS.some((o) => o.value === value));
}

export function ratingToAges(rating: VideoRating): Record<string, number> | null {
  return rating === null ? null : { ANY: rating };
}

export function agesToRating(ages: Record<string, number> | null | undefined): VideoRating {
  const any = ages?.ANY;
  return typeof any === "number" ? any : null;
}
