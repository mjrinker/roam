/** How alike two films or shows are, and how well a title fits what a profile has liked. Pure, so it can be tested without a database. */

export interface Features {
  genres: ReadonlySet<string>;
  /** The top-billed cast (TMDB person ids). */
  cast: ReadonlySet<number>;
  /** Directors and creators. */
  makers: ReadonlySet<number>;
  year: number | null;
}

const jaccard = (a: ReadonlySet<unknown>, b: ReadonlySet<unknown>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
};

const shared = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
};

/** Higher is more alike. Genres count most, then a shared director or creator, then shared cast, then how close the years are. */
export function similarity(a: Features, b: Features): number {
  const years = a.year !== null && b.year !== null ? Math.max(0, 1 - Math.abs(a.year - b.year) / 20) : 0;
  return jaccard(a.genres, b.genres) * 3 + Math.min(shared(a.makers, b.makers), 2) * 1.5 + Math.min(shared(a.cast, b.cast), 3) * 0.8 + years * 0.5;
}

/** Below this, two titles are not worth calling alike (a lone shared year, say). */
export const MIN_SIMILARITY = 1.2;

/**
 * How much a rating says about taste, from -1 (disliked) to +1 (loved). Three stars and under 3.5 are neutral; a title finished without a rating
 * counts a little in its favour.
 */
export function ratingWeight(halfStars: number | null, finished: boolean): number {
  if (halfStars === null) return finished ? 0.3 : 0;
  if (halfStars >= 7) return (halfStars - 5) / 5;
  if (halfStars <= 4) return -(5 - halfStars) / 4;
  return 0;
}

export interface Taste {
  id: string;
  name: string;
  features: Features;
  weight: number;
}

export interface Fit {
  score: number;
  /** The liked title that fits best, to say "because you liked …". */
  because: Taste | null;
}

const TOP_LIKED = 5;

/** How well a candidate fits the liked titles (the best few count, so a long history does not drown a close match) less a nudge for disliked ones. */
export function fit(candidate: Features, taste: readonly Taste[]): Fit {
  // Only genuine likeness counts (not a lone year in common), and the best few of those.
  const liked = taste.filter((t) => t.weight > 0).map((t) => ({ t, raw: similarity(candidate, t.features) })).filter((x) => x.raw >= MIN_SIMILARITY).map((x) => ({ t: x.t, s: x.raw * x.t.weight })).sort((a, b) => b.s - a.s);
  if (liked.length === 0) return { score: 0, because: null };
  const positive = liked.slice(0, TOP_LIKED).reduce((sum, x) => sum + x.s, 0);
  const disliked = taste.filter((t) => t.weight < 0).reduce((worst, t) => { const raw = similarity(candidate, t.features); return raw >= MIN_SIMILARITY ? Math.max(worst, raw * -t.weight) : worst; }, 0);
  return { score: Math.max(0, positive - disliked * 0.6), because: liked[0].t };
}
