import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  UNRATED,
  activeFilterCount,
  applyFilters,
  sortItems,
  type BrowseItem,
} from "@/lib/library/browse";

function item(name: string, over: Partial<BrowseItem> = {}): BrowseItem {
  return {
    name,
    subtitle: null,
    year: null,
    addedAtMs: 0,
    genres: [],
    runtimeSeconds: null,
    certification: null,
    ratingAge: null,
    imdbRating: null,
    rottenTomatoesScore: null,
    needsAudioFix: false,
    ...over,
  };
}

describe("applyFilters", () => {
  const a = item("A", { genres: ["Drama"], runtimeSeconds: 5400, certification: "PG", needsAudioFix: true });
  const b = item("B", { genres: ["Comedy", "Drama"], runtimeSeconds: 7200, certification: "R" });
  const c = item("C", { genres: [], runtimeSeconds: null });
  const all = [a, b, c];

  it("passes everything with no filters", () => {
    expect(applyFilters(all, EMPTY_FILTERS)).toEqual(all);
  });

  it("matches any selected genre", () => {
    expect(applyFilters(all, { ...EMPTY_FILTERS, genres: new Set(["Comedy", "Horror"]) })).toEqual([b]);
    expect(applyFilters(all, { ...EMPTY_FILTERS, genres: new Set(["Drama"]) })).toEqual([a, b]);
  });

  it("matches any selected certification, with Unrated covering null", () => {
    expect(applyFilters(all, { ...EMPTY_FILTERS, certifications: new Set(["PG", "R"]) })).toEqual([a, b]);
    expect(applyFilters(all, { ...EMPTY_FILTERS, certifications: new Set([UNRATED]) })).toEqual([c]);
  });

  it("filters duration inclusively and drops unknown runtimes once bounded", () => {
    expect(applyFilters(all, { ...EMPTY_FILTERS, minSeconds: 5400, maxSeconds: 5400 })).toEqual([a]);
    expect(applyFilters(all, { ...EMPTY_FILTERS, minSeconds: 6000, maxSeconds: null })).toEqual([b]);
    expect(applyFilters(all, { ...EMPTY_FILTERS, minSeconds: null, maxSeconds: 6000 })).toEqual([a]);
  });

  it("filters to titles whose audio needs fixing", () => {
    expect(applyFilters(all, { ...EMPTY_FILTERS, audioNeedsFix: true })).toEqual([a]);
  });

  it("ANDs different filters", () => {
    expect(
      applyFilters(all, { ...EMPTY_FILTERS, genres: new Set(["Drama"]), certifications: new Set(["R"]) })
    ).toEqual([b]);
  });
});

describe("activeFilterCount", () => {
  it("counts each active filter group once", () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(
      activeFilterCount({
        genres: new Set(["a", "b"]),
        certifications: new Set(),
        minSeconds: 1,
        maxSeconds: null,
        audioNeedsFix: true,
      })
    ).toBe(3);
  });
});

describe("sortItems", () => {
  it("toggles direction and always puts missing values last", () => {
    const x = item("X", { imdbRating: 6 });
    const y = item("Y", { imdbRating: 8 });
    const z = item("Z");
    expect(sortItems([z, x, y], "imdb", "desc").map((i) => i.name)).toEqual(["Y", "X", "Z"]);
    expect(sortItems([z, x, y], "imdb", "asc").map((i) => i.name)).toEqual(["X", "Y", "Z"]);
  });

  it("sorts titles both ways", () => {
    const items = [item("b"), item("a"), item("c")];
    expect(sortItems(items, "title", "asc").map((i) => i.name)).toEqual(["a", "b", "c"]);
    expect(sortItems(items, "title", "desc").map((i) => i.name)).toEqual(["c", "b", "a"]);
  });

  it("orders content rating by minimum age, unrated last", () => {
    const g = item("G", { ratingAge: 0 });
    const r = item("R", { ratingAge: 17 });
    const nr = item("NR");
    expect(sortItems([nr, r, g], "contentRating", "asc").map((i) => i.name)).toEqual(["G", "R", "NR"]);
    expect(sortItems([nr, r, g], "contentRating", "desc").map((i) => i.name)).toEqual(["R", "G", "NR"]);
  });

  it("sorts authors with missing ones last and breaks ties by name", () => {
    const items = [
      item("t2", { subtitle: "Zed" }),
      item("t1", { subtitle: "Abe" }),
      item("t3"),
      item("t0", { subtitle: "Abe" }),
    ];
    expect(sortItems(items, "author", "asc").map((i) => i.name)).toEqual(["t0", "t1", "t2", "t3"]);
    expect(sortItems(items, "author", "desc").map((i) => i.name)).toEqual(["t2", "t0", "t1", "t3"]);
  });
});
