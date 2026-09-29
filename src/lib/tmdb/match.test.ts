import { describe, expect, it } from "vitest";
import { pickBestMatch, yearOf } from "./match";

const read = (r: { title: string; year: number | null }) => r;

describe("yearOf", () => {
  it("reads the year from a TMDB date", () => {
    expect(yearOf("2000-07-07")).toBe(2000);
    expect(yearOf("")).toBeNull();
    expect(yearOf(undefined)).toBeNull();
  });
});

describe("pickBestMatch", () => {
  const chaplin = { title: "The Kid", year: 1921 };
  const willis = { title: "The Kid", year: 2000 };
  const kidReissue = { title: "The Kid", year: 2015 };

  it("prefers the requested year over a more popular older film", () => {
    expect(pickBestMatch([chaplin, willis], "The Kid", 2000, read)).toBe(willis);
  });

  it("takes TMDB's top hit when no year is given", () => {
    expect(pickBestMatch([chaplin, willis], "The Kid", null, read)).toBe(chaplin);
  });

  it("prefers an exact year over an adjacent one", () => {
    const off = { title: "Heat", year: 1996 };
    const exact = { title: "Heat", year: 1995 };
    expect(pickBestMatch([off, exact], "Heat", 1995, read)).toBe(exact);
  });

  it("allows a year off by one", () => {
    expect(pickBestMatch([chaplin, willis], "The Kid", 2001, read)).toBe(willis);
  });

  it("prefers an exact title within the same year distance", () => {
    const fuzzy = { title: "The Kid Stays in the Picture", year: 2000 };
    expect(pickBestMatch([fuzzy, willis], "The Kid", 2000, read)).toBe(willis);
  });

  it("ignores punctuation and case in titles", () => {
    const a = { title: "Se7en", year: 1995 };
    const b = { title: "Seven: Extra", year: 1995 };
    expect(pickBestMatch([b, a], "se7en", 1995, read)).toBe(a);
  });

  it("falls back to an exact-title hit in a distant year", () => {
    expect(pickBestMatch([chaplin, kidReissue], "The Kid", 2000, read)).toBe(chaplin);
  });

  it("returns null when nothing is close in year or title", () => {
    const other = { title: "Something Else", year: 1950 };
    expect(pickBestMatch([other], "The Kid", 2000, read)).toBeNull();
    expect(pickBestMatch([], "The Kid", 2000, read)).toBeNull();
  });
});
