import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS, nextSort, optionsQuery, parseLetter, parseLibraryOptions } from "./library-options";

const parse = (q: string) => parseLibraryOptions(new URLSearchParams(q));

describe("library options", () => {
  it("default to title order with nothing filtered", () => {
    expect(parse("")).toEqual(DEFAULT_OPTIONS);
  });
  it("read what is asked for and ignore the rest", () => {
    expect(parse("sort=year&genre=Drama&unwatched=1&owner=none")).toEqual({ sort: "year", genre: "Drama", unwatched: true, owner: "none" });
    expect(parse("sort=weird&unwatched=yes&owner=not-an-id&genre=%20%20")).toEqual(DEFAULT_OPTIONS);
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(parse(`owner=${id}`).owner).toBe(id);
  });
  it("cut a long or messy genre down", () => {
    expect(parse(`genre=${"x".repeat(200)}`).genre).toHaveLength(60);
    expect(parse("genre=a%00b").genre).toBe("ab");
  });
  it("go back into an address with the defaults left out, and keep extras", () => {
    expect(optionsQuery(DEFAULT_OPTIONS)).toBe("");
    expect(optionsQuery(DEFAULT_OPTIONS, { page: 3 })).toBe("?page=3");
    expect(parse(optionsQuery({ sort: "added", genre: "Sci-Fi & Fantasy", unwatched: true, owner: null }, { page: 2 }))).toEqual({ sort: "added", genre: "Sci-Fi & Fantasy", unwatched: true, owner: null });
  });
  it("cycle through the sorts", () => {
    expect(nextSort("title")).toBe("year");
    expect(nextSort("year")).toBe("added");
    expect(nextSort("added")).toBe("title");
  });
  it("read a letter", () => {
    expect([parseLetter("k"), parseLetter("#"), parseLetter("KK"), parseLetter("1"), parseLetter(null)]).toEqual(["K", "#", null, null, null]);
  });
});
