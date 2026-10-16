import { describe, expect, it } from "vitest";
import { formatSortLabel, type SortValues } from "./smart-labels";

const values = (over: Partial<SortValues> = {}): SortValues => ({ runtime: null, mine: null, year: null, added: null, watchedAt: null, genre: null, imdb: null, rottenTomatoes: null, average: null, certification: null, height: null, ...over });

describe("the value an item is ordered by, in words", () => {
  it("says the length for the duration sorts", () => {
    expect(formatSortLabel("longest", values({ runtime: 6000 }), false)).toBe("1h 40m");
    expect(formatSortLabel("shortest", values({ runtime: 2700 }), true)).toBe("45m");
    expect(formatSortLabel("longest", values(), false)).toBeNull();
  });
  it("shows the owner's own rating and watching only to the owner", () => {
    expect(formatSortLabel("rating", values({ mine: 7 }), true)).toBe("★ 3.5");
    expect(formatSortLabel("ratingLowest", values({ mine: 2 }), true)).toBe("★ 1");
    expect(formatSortLabel("rating", values({ mine: 7 }), false)).toBeNull();
    expect(formatSortLabel("watchedRecently", values({ watchedAt: new Date("2026-06-03T12:00:00Z") }), true)).toBe("Watched Jun 3, 2026");
    expect(formatSortLabel("watchedLongAgo", values(), true)).toBe("Not watched");
    expect(formatSortLabel("watchedRecently", values({ watchedAt: new Date("2026-06-03T12:00:00Z") }), false)).toBeNull();
  });
  it("shows what is public to anyone: year, added, genre, scores, server average, content rating, quality", () => {
    expect(formatSortLabel("newest", values({ year: 1999 }), false)).toBe("1999");
    expect(formatSortLabel("added", values({ added: new Date("2025-03-01T00:00:00Z") }), false)).toBe("Added Mar 1, 2025");
    expect(formatSortLabel("genre", values({ genre: "Drama" }), false)).toBe("Drama");
    expect(formatSortLabel("imdb", values({ imdb: 8.5 }), false)).toBe("IMDb 8.5");
    expect(formatSortLabel("rottenTomatoes", values({ rottenTomatoes: 0 }), false)).toBe("0% on Rotten Tomatoes");
    expect(formatSortLabel("average", values({ average: { halfStars: 8.4, count: 3 } }), false)).toBe("★ 4 on this server");
    expect(formatSortLabel("contentRating", values({ certification: "PG-13" }), false)).toBe("PG-13");
    expect([2160, 1080, 720, 480].map((h) => formatSortLabel("quality", values({ height: h }), false))).toEqual(["4K", "1080p", "720p", "480p"]);
  });
  it("has nothing to say for name and random orders", () => {
    expect(formatSortLabel("title", values({ year: 2000 }), true)).toBeNull();
    expect(formatSortLabel("random", values({ year: 2000 }), true)).toBeNull();
  });
});
