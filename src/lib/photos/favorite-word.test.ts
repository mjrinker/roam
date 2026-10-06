import { describe, expect, it } from "vitest";
import { favoriteWord, favoriteWords } from "./favorite-word";

describe("favoriteWord", () => {
  it("is 'Favorite' for en-US and for anything unknown, missing or odd (the default)", () => {
    for (const l of ["en-US", "en_US", "EN-us", "en", "", null, undefined, "fr-FR", "de", "xx-YY", "en-", "garbage", "es-MX", "en-PH"]) {
      expect(favoriteWord(l), String(l)).toBe("Favorite");
    }
  });
  it("is 'Favourite' for the locales that spell it that way", () => {
    for (const l of ["en-GB", "en_GB", "en-gb", "en-AU", "en-NZ", "en-IE", "en-ZA", "en-IN", "en-CA"]) {
      expect(favoriteWord(l), l).toBe("Favourite");
    }
  });
  it("uses the same spelling in every phrase", () => {
    expect(favoriteWords("en-US")).toMatchObject({ word: "Favorite", plural: "Favorites", add: "Add to favorites", remove: "Remove from favorites", empty: "No favorites yet" });
    expect(favoriteWords("en-GB")).toMatchObject({ word: "Favourite", plural: "Favourites", add: "Add to favourites", remove: "Remove from favourites", empty: "No favourites yet" });
    expect(favoriteWords("en-GB").emptyHint).toContain("favourites");
  });
});
