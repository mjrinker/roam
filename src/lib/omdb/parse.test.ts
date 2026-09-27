import { describe, expect, it } from "vitest";
import { parseOmdbResponse } from "./parse";

const HIT = {
  Title: "Interstellar",
  imdbID: "tt0816692",
  imdbRating: "8.7",
  imdbVotes: "1,987,654",
  Ratings: [
    { Source: "Internet Movie Database", Value: "8.7/10" },
    { Source: "Rotten Tomatoes", Value: "73%" },
    { Source: "Metacritic", Value: "74/100" },
  ],
  Response: "True",
};

describe("parseOmdbResponse", () => {
  it("parses a full hit", () => {
    expect(parseOmdbResponse(HIT)).toEqual({
      imdbRating: 8.7,
      imdbVotes: 1987654,
      rottenTomatoesScore: 73,
      metascore: 74,
    });
  });

  it("returns null for a miss", () => {
    expect(parseOmdbResponse({ Response: "False", Error: "Movie not found!" })).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseOmdbResponse(null)).toBeNull();
    expect(parseOmdbResponse("nope")).toBeNull();
    expect(parseOmdbResponse({})).toBeNull();
  });

  it("tolerates a title with no Rotten Tomatoes or Metacritic entry", () => {
    expect(
      parseOmdbResponse({
        imdbRating: "6.2",
        imdbVotes: "412",
        Ratings: [{ Source: "Internet Movie Database", Value: "6.2/10" }],
        Response: "True",
      })
    ).toEqual({ imdbRating: 6.2, imdbVotes: 412, rottenTomatoesScore: null, metascore: null });
  });

  it("treats N/A and missing fields as null rather than throwing", () => {
    expect(parseOmdbResponse({ imdbRating: "N/A", imdbVotes: "N/A", Response: "True" })).toEqual({
      imdbRating: null,
      imdbVotes: null,
      rottenTomatoesScore: null,
      metascore: null,
    });
  });

  it("falls back to the flat Metascore field when Ratings has no Metacritic entry", () => {
    expect(
      parseOmdbResponse({ imdbRating: "7.0", Metascore: "55", Ratings: [], Response: "True" })
    ).toMatchObject({ metascore: 55 });
  });

  it("rejects an out-of-range percentage or score", () => {
    expect(
      parseOmdbResponse({
        Ratings: [{ Source: "Rotten Tomatoes", Value: "150%" }],
        Response: "True",
      })
    ).toMatchObject({ rottenTomatoesScore: null });
  });
});
