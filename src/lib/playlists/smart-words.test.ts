import { describe, expect, it } from "vitest";
import { smartRulesSchema } from "./smart";
import { activeConditions, CLEARED, CONDITIONS, describeRules, SORT_SHORT, SORT_WORDS, toggleSort } from "./smart-words";

const words = (o: Record<string, unknown>, libs?: { id: string; name: string; kind: string }[]) => describeRules(smartRulesSchema.parse({ media: "movies", ...o }), libs);

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
    expect(activeConditions(rulesOf({ titleContains: "x", person: "y", maxAge: 0, minRottenTomatoes: 70, minAverage: 8, minHeight: 1080, notWatchedWithinDays: 30 }))).toEqual(["name", "person", "age", "scores", "average", "quality", "lastWatched"]);
    expect(activeConditions(rulesOf({ rated: "unrated" }))).toEqual(["rating"]);
  });
  it("offer every condition once, and taking one away clears exactly what it set", () => {
    expect(CONDITIONS.map((c) => c.key)).toEqual(["watched", "genres", "label", "rating", "years", "added", "duration", "name", "person", "age", "scores", "average", "quality", "lastWatched"]);
    const full = rulesOf({ watched: "watched", genres: ["A"], minStars: 2, maxStars: 9, rated: "rated", yearFrom: 1990, yearTo: 2000, addedWithinDays: 5, minMinutes: 10, maxMinutes: 20, titleContains: "t", person: "p", maxAge: 7, minImdb: 7, minRottenTomatoes: 80, minAverage: 6, minHeight: 720, watchedWithinDays: 9, labelIds: ["123e4567-e89b-42d3-a456-426614174000"] });
    for (const { key } of CONDITIONS) {
      const after = { ...full, ...CLEARED[key] };
      expect(activeConditions(after)).toEqual(activeConditions(full).filter((k) => k !== key));
    }
  });
});

describe("labels in words", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const id2 = "223e4567-e89b-42d3-a456-426614174000";
  it("name the labels when they are known, and say so plainly when they are not (another profile's rules)", () => {
    const r = smartRulesSchema.parse({ media: "movies", labelIds: [id, id2] });
    expect(describeRules(r, undefined, [{ id, name: "Date night" }, { id: id2, name: "Xmas" }])).toContain("labelled “Date night” or “Xmas”");
    expect(describeRules(r)).toContain("under my labels");
  });
});

describe("the newer conditions in words", () => {
  it("say each of them", () => {
    expect(words({ titleContains: "king", person: "Weaver", maxAge: 13, minImdb: 7.5, minRottenTomatoes: 80, minAverage: 8, minHeight: 1080, watchedWithinDays: 14 })).toBe(
      "All movies, with “king” in the name, with Weaver, rated for ages up to 13, IMDb 7.5 or more, Rotten Tomatoes 80% or more, rated 4 stars or more on this server, Full HD (1080p) or better, watched in the last 14 days; A to Z, up to 50."
    );
    expect(words({ maxAge: 0, notWatchedWithinDays: 1, minHeight: 2160 })).toContain("for everyone, 4K or better, not watched in the last day");
  });
  it("read as nothing when the text is blank", () => {
    expect(smartRulesSchema.parse({ titleContains: "   ", person: "" })).toMatchObject({ titleContains: null, person: null });
  });
});

describe("several orders", () => {
  it("reads a single saved order as a list of one, keeps the order given, and drops repeats", () => {
    expect(smartRulesSchema.parse({ sort: "newest" })).toMatchObject({ sorts: ["newest"] });
    expect(smartRulesSchema.parse({})).toMatchObject({ sorts: ["title"] });
    expect(smartRulesSchema.parse({ sorts: ["imdb", "newest", "imdb", "longest"] }).sorts).toEqual(["imdb", "newest", "longest"]);
  });
  it("refuses none, too many, and an unknown one", () => {
    expect(smartRulesSchema.safeParse({ sorts: [] }).success).toBe(false);
    expect(smartRulesSchema.safeParse({ sorts: ["title", "titleDesc", "newest", "oldest", "added", "addedOldest"] }).success).toBe(false);
    expect(smartRulesSchema.safeParse({ sorts: ["nope"] }).success).toBe(false);
  });
  it("says them in order in words", () => {
    expect(words({ sorts: ["newest", "rating", "title"] })).toContain("newest release first, then my highest rated first, then A to Z, up to 50.");
  });
  it("toggles: a new one goes last, choosing again takes it away, the opposite is replaced, the last one stays, random stays last, and there is a limit", () => {
    expect(toggleSort(["title"], "newest", 5)).toEqual(["title", "newest"]);
    expect(toggleSort(["title", "newest"], "title", 5)).toEqual(["newest"]);
    expect(toggleSort(["newest"], "newest", 5)).toEqual(["newest"]);
    expect(toggleSort(["rating", "newest"], "ratingLowest", 5)).toEqual(["newest", "ratingLowest"]);
    expect(toggleSort(["newest", "random"], "longest", 5)).toEqual(["newest", "longest", "random"]);
    expect(toggleSort(["newest"], "random", 5)).toEqual(["newest", "random"]);
    expect(toggleSort(["a", "b", "c", "d", "e"] as never, "random", 5)).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("has a short name for every order", () => {
    expect(Object.keys(SORT_SHORT)).toEqual(Object.keys(SORT_WORDS));
  });
});

describe("sorts in words", () => {
  it("has words for every sort, in the order the form lists them", () => {
    const sorts = Object.keys(SORT_WORDS);
    expect(sorts).toEqual(["title", "titleDesc", "newest", "oldest", "added", "addedOldest", "rating", "ratingLowest", "longest", "shortest", "watchedRecently", "watchedLongAgo", "genre", "imdb", "rottenTomatoes", "average", "contentRating", "quality", "random"]);
    expect(sorts.every((k) => SORT_WORDS[k as keyof typeof SORT_WORDS].length > 0)).toBe(true);
    expect(sorts.every((k) => smartRulesSchema.safeParse({ sort: k }).success)).toBe(true);
    expect(words({ sort: "longest" })).toContain("longest first");
    expect(words({ sort: "watchedLongAgo" })).toContain("watched longest ago first");
  });
});

describe("libraries in words", () => {
  const A = "123e4567-e89b-42d3-a456-426614174001";
  const B = "123e4567-e89b-42d3-a456-426614174002";
  const C = "123e4567-e89b-42d3-a456-426614174003";
  const D = "123e4567-e89b-42d3-a456-426614174004";
  const libs = [{ id: A, name: "Movies", kind: "movies" }, { id: B, name: "Kids' Movies", kind: "movies" }, { id: C, name: "TV", kind: "shows" }, { id: D, name: "Music", kind: "music" }];
  const mine = (o: Record<string, unknown>) => describeRules(smartRulesSchema.parse(o), libs);

  it("names the libraries, and calls the contents by what they are", () => {
    expect(mine({ libraryIds: [A] })).toBe("All movies in Movies; A to Z, up to 50.");
    expect(mine({ libraryIds: [A, B] })).toBe("All movies in Movies and Kids' Movies; A to Z, up to 50.");
    expect(mine({ libraryIds: [A, B, C] })).toBe("All titles in Movies, Kids' Movies and TV; A to Z, up to 50.");
    expect(mine({ libraryIds: [A, B, C, D] })).toContain("All titles in 4 libraries");
    expect(mine({ libraryIds: [D] })).toContain("All songs in Music");
    expect(mine({})).toBe("All titles; A to Z, up to 50.");
  });
  it("says episodes for a TV library held as episodes, and leaves duration out when only whole shows", () => {
    expect(mine({ libraryIds: [C], showsAs: "episodes", minMinutes: 20 })).toBe("All episodes in TV, at least 20 min long; A to Z, up to 50.");
    expect(mine({ libraryIds: [C], minMinutes: 20 })).toBe("All shows in TV; A to Z, up to 50.");
  });
  it("still reads a library it cannot see the name of", () => {
    expect(describeRules(smartRulesSchema.parse({ libraryIds: [A] }))).toBe("All titles; A to Z, up to 50.");
  });
});
