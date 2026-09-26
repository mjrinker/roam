import { describe, expect, it } from "vitest";
import {
  groupFilesByEpisodeNumber,
  isExtraFile,
  isVideoFile,
  orderMediaSegments,
  parseEditionTag,
  parseEpisodeFileName,
  parseSeasonFolderName,
  parseTitleFolderName,
} from "./conventions";

describe("parseTitleFolderName", () => {
  it("extracts name and year", () => {
    expect(parseTitleFolderName("The Matrix (1999)")).toEqual({
      name: "The Matrix",
      year: 1999,
      tmdbId: null,
      edition: null,
    });
  });

  it("handles no year", () => {
    expect(parseTitleFolderName("Some Home Video")).toEqual({
      name: "Some Home Video",
      year: null,
      tmdbId: null,
      edition: null,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseTitleFolderName("  The Matrix (1999)  ")).toEqual({
      name: "The Matrix",
      year: 1999,
      tmdbId: null,
      edition: null,
    });
  });

  it("handles titles that themselves contain parentheses before the year", () => {
    expect(parseTitleFolderName("Se7en (a.k.a. Seven) (1995)")).toEqual({
      name: "Se7en (a.k.a. Seven)",
      year: 1995,
      tmdbId: null,
      edition: null,
    });
  });

  it("extracts a {tmdb-...} id tag and strips it from the name", () => {
    expect(parseTitleFolderName("The Matrix (1999) {tmdb-603}")).toEqual({
      name: "The Matrix",
      year: 1999,
      tmdbId: 603,
      edition: null,
    });
  });

  it("extracts a {tmdb-...} tag on a show folder with no year", () => {
    expect(parseTitleFolderName("John Adams {tmdb-15114}")).toEqual({
      name: "John Adams",
      year: null,
      tmdbId: 15114,
      edition: null,
    });
  });

  it("strips {imdb-...}/{tvdb-...} tags without resolving them", () => {
    expect(parseTitleFolderName("The Matrix (1999) {imdb-tt0133093}")).toEqual({
      name: "The Matrix",
      year: 1999,
      tmdbId: null,
      edition: null,
    });
    expect(parseTitleFolderName("John Adams (2008) {tvdb-81547}")).toEqual({
      name: "John Adams",
      year: 2008,
      tmdbId: null,
      edition: null,
    });
  });

  it("extracts a directory-level {edition-...} tag", () => {
    expect(
      parseTitleFolderName("Star Wars - Episode 4 (1977) {edition-Original Theatrical Release}")
    ).toEqual({
      name: "Star Wars - Episode 4",
      year: 1977,
      tmdbId: null,
      edition: "Original Theatrical Release",
    });
  });

  it("handles both an id tag and an edition tag together", () => {
    expect(
      parseTitleFolderName("The Matrix (1999) {tmdb-603} {edition-Extended Cut}")
    ).toEqual({
      name: "The Matrix",
      year: 1999,
      tmdbId: 603,
      edition: "Extended Cut",
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

describe("parseEditionTag", () => {
  it("extracts a file-level {edition-...} tag", () => {
    expect(
      parseEditionTag("Star Wars - Episode 4 (1977).1080p.h264 {edition-Blu-ray Release}.mp4")
    ).toBe("Blu-ray Release");
  });

  it("returns null when there's no edition tag", () => {
    expect(parseEditionTag("The Matrix (1999).mp4")).toBeNull();
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

  it("doesn't treat a split-file suffix as the episode title", () => {
    expect(parseEpisodeFileName("John Adams - s01e02 - pt1.mp4")).toEqual({
      season: 1,
      episode: 2,
      name: null,
    });
    expect(parseEpisodeFileName("Show - S01E03 - disc2.mp4")).toEqual({
      season: 1,
      episode: 3,
      name: null,
    });
  });

  it("doesn't treat a multi-episode range suffix as the episode title", () => {
    expect(parseEpisodeFileName("John Adams - s01e05-e06.mp4")).toEqual({
      season: 1,
      episode: 5,
      name: null,
    });
    expect(parseEpisodeFileName("John Adams - s01e05-06.mp4")).toEqual({
      season: 1,
      episode: 5,
      name: null,
    });
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

  it.each(["pt", "cd", "disc", "disk", "dvd"])(
    "recognizes Plex's %s split-file keyword",
    (keyword) => {
      const files = [
        { name: `Movie Title (2001) - ${keyword}2.mp4` },
        { name: `Movie Title (2001) - ${keyword}1.mp4` },
      ];
      expect(orderMediaSegments(files).map((f) => f.name)).toEqual([
        `Movie Title (2001) - ${keyword}1.mp4`,
        `Movie Title (2001) - ${keyword}2.mp4`,
      ]);
    }
  );

  it("doesn't false-positive on a title that happens to contain a split keyword as a substring", () => {
    const files = [{ name: "The Apartment (1960).mp4" }];
    expect(orderMediaSegments(files).map((f) => f.name)).toEqual(["The Apartment (1960).mp4"]);
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

describe("groupFilesByEpisodeNumber", () => {
  it("groups a multi-part episode's files together under one key", () => {
    const files = [
      { name: "S01E01 - part2.mp4" },
      { name: "S01E01 - part1.mp4" },
      { name: "S01E02.mp4" },
    ];
    const grouped = groupFilesByEpisodeNumber(files);
    expect([...grouped.keys()].sort()).toEqual([1, 2]);
    expect(grouped.get(1)?.map((f) => f.name)).toEqual([
      "S01E01 - part2.mp4",
      "S01E01 - part1.mp4",
    ]);
    expect(grouped.get(2)?.map((f) => f.name)).toEqual(["S01E02.mp4"]);
  });

  it("drops files that don't match the SxxExx convention", () => {
    const files = [{ name: "S01E01.mp4" }, { name: "folder.jpg" }, { name: "random.mp4" }];
    const grouped = groupFilesByEpisodeNumber(files);
    expect([...grouped.keys()]).toEqual([1]);
  });

  it("returns an empty map for no matching files", () => {
    expect(groupFilesByEpisodeNumber([{ name: "nope.mp4" }]).size).toBe(0);
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

describe("isExtraFile", () => {
  it.each([
    "Trailer 1-trailer.mov",
    "Teaser Trailer-trailer.mp4",
    "Bar Fight-deleted.mp4",
    "Performance Capture-behindthescenes.mkv",
    "Convention Panel-featurette.mp4",
    "Director Q&A-interview.mp4",
    "Alternate Ending-scene.mp4",
    "Animated Short-short.mp4",
    "Bonus Content-other.mp4",
  ])("flags %s as an extra", (name) => {
    expect(isExtraFile(name)).toBe(true);
  });

  it.each([
    "The Matrix (1999).mp4",
    "Extraordinary Machine (2019).mp4",
    "part1.mp4",
    "S01E01 - Pilot.mp4",
    "Short Circuit (1986).mp4",
    "The Deleted (2010).mp4",
    "Movie.Trailer.mp4",
  ])("does not flag %s as an extra", (name) => {
    expect(isExtraFile(name)).toBe(false);
  });
});
