import { Star } from "lucide-react";

export interface ExternalRatingsData {
  imdbRating: number | null;
  /** Rotten Tomatoes Tomatometer (critics), 0-100. RT has no free API for the audience score. */
  rottenTomatoesScore: number | null;
}

/** A tomato-shaped glyph so the badge reads as Rotten Tomatoes at a glance without a licensed logo. */
function TomatoIcon({ fresh }: { fresh: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
      <path
        d="M8 3.2c-.3-.9-1.1-1.6-1.1-1.6s1.4-.3 2 .5c.2-.9 1.4-1.4 1.4-1.4s-.2 1.1-.8 1.7c2.6.5 4.3 2.6 4.3 5.3 0 3-2.6 5.6-5.8 5.6S2.2 10.7 2.2 7.7c0-2.6 1.6-4.6 3.9-5.2Z"
        fill={fresh ? "#fa320a" : "#6b8e23"}
      />
    </svg>
  );
}

/** Small IMDb / Rotten Tomatoes score badges for a detail page. Renders nothing if neither score is present. */
export function ExternalRatings({ imdbRating, rottenTomatoesScore }: ExternalRatingsData) {
  if (imdbRating === null && rottenTomatoesScore === null) return null;

  return (
    <div className="flex flex-wrap items-center justify-center gap-2 md:justify-start">
      {imdbRating !== null && (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1 text-xs font-medium ring-1 ring-white/10 backdrop-blur">
          <Star className="size-3.5 fill-amber-400 text-amber-400" />
          {imdbRating.toFixed(1)}
          <span className="text-muted-foreground">IMDb</span>
        </span>
      )}
      {rottenTomatoesScore !== null && (
        <span className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1 text-xs font-medium ring-1 ring-white/10 backdrop-blur">
          <TomatoIcon fresh={rottenTomatoesScore >= 60} />
          {rottenTomatoesScore}%
          <span className="text-muted-foreground">Rotten Tomatoes</span>
        </span>
      )}
    </div>
  );
}
