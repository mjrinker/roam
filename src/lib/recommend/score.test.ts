import { describe, expect, it } from "vitest";
import { fit, MIN_SIMILARITY, ratingWeight, similarity, type Features, type Taste } from "./score";

const f = (over: Partial<{ genres: string[]; cast: number[]; makers: number[]; year: number | null }> = {}): Features => ({ genres: new Set(over.genres ?? []), cast: new Set(over.cast ?? []), makers: new Set(over.makers ?? []), year: over.year ?? null });

describe("similarity", () => {
  it("is greater for more shared genres, a shared director, shared cast and nearby years", () => {
    const base = f({ genres: ["Drama", "Crime"], cast: [1, 2], makers: [9], year: 2000 });
    const same = similarity(base, base);
    const genresOnly = similarity(base, f({ genres: ["Drama", "Crime"] }));
    const half = similarity(base, f({ genres: ["Drama", "Comedy"] }));
    expect(same).toBeGreaterThan(genresOnly);
    expect(genresOnly).toBeGreaterThan(half);
    expect(similarity(base, f({ makers: [9] }))).toBeGreaterThan(similarity(base, f({ cast: [1] })));
    expect(similarity(base, f({ year: 2001 }))).toBeGreaterThan(similarity(base, f({ year: 1980 })));
  });
  it("is nothing for titles with nothing in common, and a lone nearby year is not enough", () => {
    expect(similarity(f({ genres: ["A"], cast: [1], makers: [2], year: 1950 }), f({ genres: ["B"], cast: [3], makers: [4], year: 2020 }))).toBe(0);
    expect(similarity(f({ year: 2000 }), f({ year: 2000 }))).toBeLessThan(MIN_SIMILARITY);
  });
  it("is symmetric, and caps what shared cast or makers can add", () => {
    const a = f({ genres: ["X", "Y"], cast: [1, 2, 3, 4, 5], makers: [1, 2, 3] });
    const b = f({ genres: ["X"], cast: [1, 2, 3, 4, 5], makers: [1, 2, 3] });
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a));
    expect(similarity(f({ cast: [1, 2, 3, 4, 5] }), f({ cast: [1, 2, 3, 4, 5] }))).toBeCloseTo(2.4);
    expect(similarity(f({ makers: [1, 2, 3] }), f({ makers: [1, 2, 3] }))).toBeCloseTo(3);
  });
});

describe("ratingWeight", () => {
  it("likes high ratings, dislikes low ones, is neutral in the middle, and counts a finished unrated title a little", () => {
    expect([10, 9, 8, 7].map((r) => ratingWeight(r, false))).toEqual([1, 0.8, 0.6, 0.4].map((x) => expect.closeTo(x, 5)));
    expect([6, 5].map((r) => ratingWeight(r, false))).toEqual([0, 0]);
    expect([4, 2, 1].map((r) => ratingWeight(r, false))).toEqual([-0.25, -0.75, -1]);
    expect(ratingWeight(null, true)).toBe(0.3);
    expect(ratingWeight(null, false)).toBe(0);
    expect(ratingWeight(9, true)).toBeCloseTo(0.8); // the rating wins over merely finishing
  });
});

describe("fit", () => {
  const taste = (id: string, features: Features, weight: number): Taste => ({ id, name: id, features, weight });
  const horror = f({ genres: ["Horror", "Thriller"], year: 1990 });
  const comedy = f({ genres: ["Comedy"], year: 1990 });

  it("is nothing without anything liked", () => {
    expect(fit(horror, [])).toEqual({ score: 0, because: null });
    expect(fit(horror, [taste("h", horror, -1), taste("n", horror, 0)]).score).toBe(0);
  });
  it("prefers what is closer to what was liked, and names the liked title it is closest to", () => {
    const likes = [taste("scream", f({ genres: ["Horror", "Thriller"], year: 1996 }), 1), taste("airplane", f({ genres: ["Comedy"], year: 1980 }), 1)];
    const a = fit(horror, likes);
    const b = fit(comedy, likes);
    expect(a.because?.id).toBe("scream");
    expect(b.because?.id).toBe("airplane");
    expect(a.score).toBeGreaterThan(0);
    expect(fit(f({ genres: ["Western"] }), likes).score).toBe(0);
  });
  it("counts a stronger like more, and lowers the score for a similar title that was disliked", () => {
    const strong = fit(horror, [taste("a", horror, 1)]).score;
    const weak = fit(horror, [taste("a", horror, 0.4)]).score;
    expect(strong).toBeGreaterThan(weak);
    const withDislike = fit(horror, [taste("a", horror, 1), taste("b", f({ genres: ["Horror", "Thriller"] }), -1)]).score;
    expect(withDislike).toBeLessThan(strong);
    expect(withDislike).toBeGreaterThanOrEqual(0);
  });
  it("only counts the best few liked titles, so a long history does not swamp a close match", () => {
    const many = Array.from({ length: 30 }, (_, i) => taste(`m${i}`, horror, 0.1));
    const few = [taste("one", horror, 1)];
    expect(fit(horror, many).score).toBeLessThan(fit(horror, few).score + 1);
    expect(fit(horror, many).score).toBeCloseTo(similarity(horror, horror) * 0.1 * 5);
  });
});
