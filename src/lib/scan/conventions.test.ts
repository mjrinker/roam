import { describe, expect, it } from "vitest";
import {
  isVideoFile,
  orderMediaSegments,
  parseEpisodeFileName,
  parseSeasonFolderName,
  parseTitleFolderName,
} from "./conventions";

describe("parseTitleFolderName", () => {
  it("extracts name and year", () => {
    expect(parseTitleFolderName("The Matrix (1999)")).toEqual({
      name: "The Matrix",
      year: 1999,
    });
  });

  it("handles no year", () => {
    expect(parseTitleFolderName("Some Home Video")).toEqual({
      name: "Some Home Video",
      year: null,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseTitleFolderName("  The Matrix (1999)  ")).toEqual({
      name: "The Matrix",
      year: 1999,
    });
  });

  it("handles titles that themselves contain parentheses before the year", () => {
    expect(parseTitleFolderName("Se7en (a.k.a. Seven) (1995)")).toEqual({
      name: "Se7en (a.k.a. Seven)",
      year: 1995,
    });
  });
});

describe("parseSeasonFolderName", () => {
  it.each([
    ["Season 01", 1],
    ["Season 1", 1],
    ["season 12", 12],
    ["Season   7", 7],
  ])("parses %s -> %i", (input, expected) => {
    expect(parseSeasonFolderName(input)).toBe(expected);
  });

  it("returns null for non-matching folder names", () => {
    expect(parseSeasonFolderName("Extras")).toBeNull();
    expect(parseSeasonFolderName("Specials")).toBeNull();
  });
});

describe("parseEpisodeFileName", () => {
  it("parses season, episode, and name", () => {
    expect(parseEpisodeFileName("S01E01 - Pilot.mp4")).toEqual({
      season: 1,
      episode: 1,
      name: "Pilot",
    });
  });

  it("parses without a title suffix", () => {
    expect(parseEpisodeFileName("S1E2.mp4")).toEqual({
      season: 1,
      episode: 2,
      name: null,
    });
  });

  it("is case-insensitive on the S/E markers", () => {
    expect(parseEpisodeFileName("s02e10 - Finale.mp4")).toEqual({
      season: 2,
      episode: 10,
      name: "Finale",
    });
  });

  it("returns null when there's no SxxExx pattern", () => {
    expect(parseEpisodeFileName("random-clip.mp4")).toBeNull();
  });
});

describe("orderMediaSegments", () => {
  it("orders partN files numerically, not alphabetically", () => {
    const files = [{ name: "part10.mp4" }, { name: "part2.mp4" }, { name: "part1.mp4" }];
    expect(orderMediaSegments(files).map((f) => f.name)).toEqual([
      "part1.mp4",
      "part2.mp4",
      "part10.mp4",
    ]);
  });

  it("handles part markers embedded anywhere in the filename", () => {
    const files = [
      { name: "Movie Title - Part 2.mp4" },
      { name: "Movie Title - Part 1.mp4" },
    ];
    expect(orderMediaSegments(files).map((f) => f.name)).toEqual([
      "Movie Title - Part 1.mp4",
      "Movie Title - Part 2.mp4",
    ]);
  });

  it("falls back to alphabetical order when there are no part markers", () => {
    const files = [{ name: "b.mp4" }, { name: "a.mp4" }];
    expect(orderMediaSegments(files).map((f) => f.name)).toEqual(["a.mp4", "b.mp4"]);
  });

  it("sorts part-marked files before unmarked ones", () => {
    const files = [{ name: "extra.mp4" }, { name: "part1.mp4" }];
    expect(orderMediaSegments(files).map((f) => f.name)).toEqual([
      "part1.mp4",
      "extra.mp4",
    ]);
  });

  it("does not mutate the input array", () => {
    const files = [{ name: "b.mp4" }, { name: "a.mp4" }];
    const original = [...files];
    orderMediaSegments(files);
    expect(files).toEqual(original);
  });
});

describe("isVideoFile", () => {
  it.each(["movie.mp4", "movie.m4v", "movie.mov", "MOVIE.MP4"])(
    "accepts %s",
    (name) => {
      expect(isVideoFile(name)).toBe(true);
    }
  );

  it.each(["movie.mkv", "movie.txt", "noextension", "movie."])(
    "rejects %s",
    (name) => {
      expect(isVideoFile(name)).toBe(false);
    }
  );
});
