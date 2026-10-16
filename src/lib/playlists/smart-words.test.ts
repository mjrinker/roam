import { describe, expect, it } from "vitest";
import { smartRulesSchema } from "./smart";
import { activeConditions, CLEARED, CONDITIONS, describeRules } from "./smart-words";

const words = (o: Record<string, unknown>) => describeRules(smartRulesSchema.parse({ media: "movies", ...o }));

describe("describeRules", () => {
  it("says the plain case", () => {
    expect(words({})).toBe("All movies; A to Z, up to 50.");
  });
  it("says what was asked in order: watching, genres, kind, rating, years, recency, then order and length", () => {
    expect(words({ watched: "unwatched", genres: ["Comedy", "Drama"], minStars: 8, yearFrom: 1990, yearTo: 1999, addedWithinDays: 30, sort: "rating", limit: 25 })).toBe(
      "Unwatched Comedy or Drama movies, rated 4 stars and up, from 1990 to 1999, added in the last 30 days; my highest rated first, up to 25."
    );
  });
  it("says each kind of rating rule", () => {
    expect(words({ maxStars: 5 })).toContain("rated 2.5 stars or less");
    expect(words({ minStars: 3, maxStars: 7 })).toContain("rated 1.5 stars to 3.5 stars");
    expect(words({ rated: "unrated" })).toContain("that I haven't rated");
    expect(words({ rated: "rated" })).toContain("that I've rated");
    expect(words({ minStars: 2 })).toContain("rated 1 star and up");
  });
  it("names the other kinds and years on one side only", () => {
    expect(words({ media: "episodes", watched: "inProgress" })).toMatch(/^Partly watched episodes/);
    expect(words({ media: "songs", yearFrom: 2000 })).toContain("from 2000 on");
    expect(words({ media: "audiobooks", yearTo: 1999, addedWithinDays: 1 })).toContain("up to 1999, added in the last day");
    expect(words({ sort: "random" })).toContain("in a random order");
  });
});

describe("duration in words", () => {
  it("says hours and minutes, and leaves it out for shows", () => {
    expect(words({ minMinutes: 90, maxMinutes: 120 })).toContain("1 h 30 min to 2 h long");
    expect(words({ minMinutes: 45 })).toContain("at least 45 min long");
    expect(words({ maxMinutes: 100 })).toContain("1 h 40 min or shorter");
    expect(words({ media: "shows", minMinutes: 45 })).not.toContain("long");
  });
});

describe("the conditions of the form", () => {
  const rulesOf = (o: Record<string, unknown>) => smartRulesSchema.parse({ media: "movies", ...o });
  it("start with none for plain rules, and show the ones the rules already use, in the order offered", () => {
    expect(activeConditions(rulesOf({}))).toEqual([]);
    expect(activeConditions(rulesOf({ maxMinutes: 100, genres: ["Drama"], watched: "unwatched", minStars: 8, yearTo: 1999, addedWithinDays: 7 }))).toEqual(["watched", "genres", "rating", "years", "added", "duration"]);
    expect(activeConditions(rulesOf({ rated: "unrated" }))).toEqual(["rating"]);
  });
  it("offer every condition once, and taking one away clears exactly what it set", () => {
    expect(CONDITIONS.map((c) => c.key)).toEqual(["watched", "genres", "rating", "years", "added", "duration"]);
    const full = rulesOf({ watched: "watched", genres: ["A"], minStars: 2, maxStars: 9, rated: "rated", yearFrom: 1990, yearTo: 2000, addedWithinDays: 5, minMinutes: 10, maxMinutes: 20 });
    for (const { key } of CONDITIONS) {
      const after = { ...full, ...CLEARED[key] };
      expect(activeConditions(after)).toEqual(activeConditions(full).filter((k) => k !== key));
    }
  });
});
