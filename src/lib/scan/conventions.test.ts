import { describe, expect, it } from "vitest";
import {
  variantFileName,
  clampEpisodesToKnown,
  isBrowserFriendlyVariant,
  stripVariantSuffix,
  groupEpisodeFiles,
  isAudioFile,
  isDiscFolderName,
  extractNarratorHint,
  isExtraFile,
  isVideoFile,
  orderAudioParts,
  orderBookParts,
  orderMediaSegments,
  parseBookFolderName,
  parseDiscFolderNumber,
  parseNarratorTag,
  parseEditionTag,
  parseEpisodeFileName,
  parseSeasonFolderName,
  parseTitleFolderName,
  folderNameWithTmdbId,
  fileNameWithTmdbId,
  groupByVersion,
  labelHeightHint,
  resolutionName,
  versionLabelOf,
} from "./conventions";

describe("parseTitleFolderName", () => {
  it("extracts name and year", () => {
    expect(parseTitleFolderName("The Matrix (1999)")).toEqual({
      name: "The Matrix",
      year: 1999,
      tmdbId: null,
      imdbId: null,
      edition: null,
    });
  });

  it("handles no year", () => {
    expect(parseTitleFolderName("Some Home Video")).toEqual({
      name: "Some Home Video",
      year: null,
      tmdbId: null,
      imdbId: null,
      edition: null,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseTitleFolderName("  The Matrix (1999)  ")).toEqual({
      name: "The Matrix",
      year: 1999,
      tmdbId: null,
      imdbId: null,
      edition: null,
    });
  });

  it("handles titles that themselves contain parentheses before the year", () => {
    expect(parseTitleFolderName("Se7en (a.k.a. Seven) (1995)")).toEqual({
      name: "Se7en (a.k.a. Seven)",
      year: 1995,
      tmdbId: null,
      imdbId: null,
      edition: null,
    });
  });

  it("extracts a {tmdb-...} id tag and strips it from the name", () => {
    expect(parseTitleFolderName("The Matrix (1999) {tmdb-603}")).toEqual({
      name: "The Matrix",
      year: 1999,
      tmdbId: 603,
      imdbId: null,
      edition: null,
    });
  });

  it("extracts a {tmdb-...} tag on a show folder with no year", () => {
    expect(parseTitleFolderName("John Adams {tmdb-15114}")).toEqual({
      name: "John Adams",
      year: null,
      tmdbId: 15114,
      imdbId: null,
      edition: null,
    });
  });

  it("extracts an {imdb-...} tag and strips it from the name", () => {
    expect(parseTitleFolderName("The Matrix (1999) {imdb-tt0133093}")).toEqual({
      name: "The Matrix",
      year: 1999,
      tmdbId: null,
      imdbId: "tt0133093",
      edition: null,
    });
  });

  it("ignores a malformed id but still strips the tag", () => {
    expect(parseTitleFolderName("The Matrix (1999) {imdb-nope} {tmdb-abc}")).toEqual({
      name: "The Matrix",
      year: 1999,
      tmdbId: null,
      imdbId: null,
      edition: null,
    });
  });

  it("strips {tvdb-...} tags without resolving them", () => {
    expect(parseTitleFolderName("The Matrix (1999) {tvdb-1}")).toEqual({
      name: "The Matrix",
      year: 1999,
      tmdbId: null,
      imdbId: null,
      edition: null,
    });
    expect(parseTitleFolderName("John Adams (2008) {tvdb-81547}")).toEqual({
      name: "John Adams",
      year: 2008,
      tmdbId: null,
      imdbId: null,
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
      imdbId: null,
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
      imdbId: null,
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
      episodes: [1],
      name: "Pilot",
      version: "",
    });
  });

  it("parses without a title suffix", () => {
    expect(parseEpisodeFileName("S1E2.mp4")).toEqual({
      season: 1,
      episode: 2,
      episodes: [2],
      name: null,
      version: "",
    });
  });

  it("is case-insensitive on the S/E markers", () => {
    expect(parseEpisodeFileName("s02e10 - Finale.mp4")).toEqual({
      season: 2,
      episode: 10,
      episodes: [10],
      name: "Finale",
      version: "",
    });
  });

  it("returns null when there's no SxxExx pattern", () => {
    expect(parseEpisodeFileName("random-clip.mp4")).toBeNull();
  });

  it("doesn't treat a split-file suffix as the episode title", () => {
    expect(parseEpisodeFileName("John Adams - s01e02 - pt1.mp4")).toEqual({
      season: 1,
      episode: 2,
      episodes: [2],
      name: null,
      version: "",
    });
    expect(parseEpisodeFileName("Show - S01E03 - disc2.mp4")).toEqual({
      season: 1,
      episode: 3,
      episodes: [3],
      name: null,
      version: "",
    });
  });

  // Full fixture table for Plex's multi-episode naming convention
  // ("S01E05-E06", or the shorthand "S01E05-06"), verified against the
  // final regex + range-extraction algorithm before being transcribed here.
  it.each<[string, { season: number; episodes: number[]; name: string | null }]>([
    ["Show - S01E05.mp4", { season: 1, episodes: [5], name: null }],
    ["Show - S01E05 - Pilot.mp4", { season: 1, episodes: [5], name: "Pilot" }],
    ["Show - S01E05-E06.mp4", { season: 1, episodes: [5, 6], name: null }],
    ["Show - S01E05-06.mp4", { season: 1, episodes: [5, 6], name: null }],
    ["Show - S01E05-E06-E07.mp4", { season: 1, episodes: [5, 6, 7], name: null }],
    ["Show - S01E05-07.mp4", { season: 1, episodes: [5, 6, 7], name: null }],
    // Fixes a real name-leak bug: this used to parse the name as "E06 - Title".
    ["Show - S01E05-E06 - Title.mp4", { season: 1, episodes: [5, 6], name: "Title" }],
    ["Show - S01E05-E06 - pt1.mp4", { season: 1, episodes: [5, 6], name: null }],
    // A multi-part file (- pt1) must NOT be mistaken for a multi-episode one.
    ["Show - S01E05 - pt1.mp4", { season: 1, episodes: [5], name: null }],
    // Invalid range (99 then 01) falls back to just the first number.
    ["Show - S01E99-E01.mp4", { season: 1, episodes: [99], name: null }],
    // A single explicit token is a valid range end regardless of size —
    // the REAL sanity check against a season's actual episode count lives
    // one layer up, in clampEpisodesToKnown/groupEpisodeFiles (see below),
    // since this pure parsing layer has no access to TMDB. This only
    // trips MAX_EPISODES_PER_FILE's much larger structural backstop.
    ["Show - S01E01-E09.mp4", { season: 1, episodes: [1, 2, 3, 4, 5, 6, 7, 8, 9], name: null }],
    // Span over MAX_EPISODES_PER_FILE's structural backstop falls back.
    ["Show - S01E01-E999.mp4", { season: 1, episodes: [1], name: null }],
    // A SINGLE explicit "-E04" token is a range end ("through episode 4"),
    // not a "must be exactly start+1" check — a real regression once: a
    // 6-episode miniseries file named "...s01e01-e06..." incorrectly fell
    // back to a single episode because 6 != 1 + 1, even though a genuine
    // 4-episode span (within the cap) should split cleanly.
    ["Show - S01E01-E04.mp4", { season: 1, episodes: [1, 2, 3, 4], name: null }],
    ["Show - S01E05-2019 recap.mp4", { season: 1, episodes: [5], name: "2019 recap" }],
    ["Show - S01E05-pt1.mp4", { season: 1, episodes: [5], name: null }],
  ])("parses %s -> %o", (input, expected) => {
    expect(parseEpisodeFileName(input)).toEqual({ ...expected, episode: expected.episodes[0], version: "" });
  });

  it.each(["Show - S01E05E06.mp4", "Show - S01E05 E06.mp4"])(
    // Not real Plex forms (no separator, or a space instead of "-"), so
    // there's no valid continuation and the whole match fails — dropped
    // entirely, same as before this feature.
    "does not treat %s as a valid episode file",
    (input) => {
      expect(parseEpisodeFileName(input)).toBeNull();
    }
  );
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

describe("groupEpisodeFiles", () => {
  it("groups a multi-part episode's files together under one key", () => {
    const files = [
      { name: "S01E01 - part2.mp4" },
      { name: "S01E01 - part1.mp4" },
      { name: "S01E02.mp4" },
    ];
    const grouped = groupEpisodeFiles(files);
    expect([...grouped.keys()].sort()).toEqual([1, 2]);
    expect(grouped.get(1)).toEqual({
      files: [{ name: "S01E01 - part1.mp4" }, { name: "S01E01 - part2.mp4" }],
      combined: false,
    });
    expect(grouped.get(2)).toEqual({ files: [{ name: "S01E02.mp4" }], combined: false });
  });

  it("drops files that don't match the SxxExx convention", () => {
    const files = [{ name: "S01E01.mp4" }, { name: "folder.jpg" }, { name: "random.mp4" }];
    const grouped = groupEpisodeFiles(files);
    expect([...grouped.keys()]).toEqual([1]);
  });

  it("returns an empty map for no matching files", () => {
    expect(groupEpisodeFiles([{ name: "nope.mp4" }]).size).toBe(0);
  });

  it("attaches a multi-episode file to every episode number it spans", () => {
    const files = [{ name: "Show - S01E05-E06.mp4" }];
    const grouped = groupEpisodeFiles(files);
    expect([...grouped.keys()].sort()).toEqual([5, 6]);
    expect(grouped.get(5)).toEqual({ files, combined: true });
    expect(grouped.get(6)).toEqual({ files, combined: true });
  });

  it("groups two parts of the same combined span together as one multi-part block", () => {
    const files = [
      { name: "Show - S01E05-E06 - pt2.mp4" },
      { name: "Show - S01E05-E06 - pt1.mp4" },
    ];
    const grouped = groupEpisodeFiles(files);
    expect(grouped.get(5)).toEqual({
      files: [{ name: "Show - S01E05-E06 - pt1.mp4" }, { name: "Show - S01E05-E06 - pt2.mp4" }],
      combined: true,
    });
    expect(grouped.get(6)).toEqual(grouped.get(5));
  });

  it("a standalone file always wins over a combined file's claim on the same episode number", () => {
    const standalone = { name: "Show - S01E06.mp4" };
    const combined = { name: "Show - S01E05-E06.mp4" };
    const grouped = groupEpisodeFiles([standalone, combined]);
    expect(grouped.get(5)).toEqual({ files: [combined], combined: true });
    expect(grouped.get(6)).toEqual({ files: [standalone], combined: false });
  });

  it("resolves two different combined spans claiming the same episode number deterministically", () => {
    const spanA = { name: "Show - S01E05-E06.mp4" };
    const spanB = { name: "Show - S01E06-E07.mp4" };
    const grouped = groupEpisodeFiles([spanB, spanA]);
    // Lowest starting episode wins (5-6 over 6-7).
    expect(grouped.get(6)).toEqual({ files: [spanA], combined: true });
  });

  it("narrows a claimed span down to what TMDB actually confirms exists for the season", () => {
    // A real case: a 6-episode miniseries filename, but TMDB only knows
    // about episodes 1-4 for this season so far.
    const files = [{ name: "Show - S01E01-E06.mp4" }];
    const grouped = groupEpisodeFiles(files, new Set([1, 2, 3, 4]));
    expect([...grouped.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(grouped.get(1)).toEqual({ files, combined: true });
  });

  it("falls back to a single episode when TMDB doesn't even confirm a second one", () => {
    const files = [{ name: "Show - S01E01-E06.mp4" }];
    const grouped = groupEpisodeFiles(files, new Set([1]));
    expect([...grouped.keys()]).toEqual([1]);
    expect(grouped.get(1)).toEqual({ files, combined: false });
  });

  it("trusts the file's own span when there's no TMDB data yet (null, not an empty set)", () => {
    const files = [{ name: "Show - S01E01-E06.mp4" }];
    const grouped = groupEpisodeFiles(files, null);
    expect([...grouped.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("clampEpisodesToKnown", () => {
  it("returns the span unchanged when there's no known-episode data", () => {
    expect(clampEpisodesToKnown([1, 2, 3], null)).toEqual([1, 2, 3]);
  });

  it("returns a single-episode span unchanged regardless of known data", () => {
    expect(clampEpisodesToKnown([5], new Set([1, 2]))).toEqual([5]);
  });

  it("keeps the full span when every episode is confirmed", () => {
    expect(clampEpisodesToKnown([1, 2, 3], new Set([1, 2, 3, 4]))).toEqual([1, 2, 3]);
  });

  it("narrows to the confirmed contiguous prefix", () => {
    expect(clampEpisodesToKnown([1, 2, 3, 4, 5, 6], new Set([1, 2, 3, 4]))).toEqual([1, 2, 3, 4]);
  });

  it("falls back to just the first episode when the confirmed prefix is under 2", () => {
    expect(clampEpisodesToKnown([1, 2, 3], new Set([1]))).toEqual([1]);
    expect(clampEpisodesToKnown([1, 2, 3], new Set([2, 3]))).toEqual([1]);
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

describe("isAudioFile", () => {
  it("accepts m4b, m4a and mp3 in any case", () => {
    expect(isAudioFile("Book.m4b")).toBe(true);
    expect(isAudioFile("Book.M4A")).toBe(true);
    expect(isAudioFile("01 Intro.mp3")).toBe(true);
  });

  it("rejects video, images and extensionless names", () => {
    expect(isAudioFile("movie.mp4")).toBe(false);
    expect(isAudioFile("cover.jpg")).toBe(false);
    expect(isAudioFile("README")).toBe(false);
  });
});

describe("orderAudioParts", () => {
  const names = (files: { name: string }[]) => files.map((f) => f.name);

  it("sorts unpadded numbers numerically, not lexically", () => {
    const files = ["Chapter 10.mp3", "Chapter 2.mp3", "Chapter 1.mp3"].map((name) => ({ name }));
    expect(names(orderAudioParts(files))).toEqual(["Chapter 1.mp3", "Chapter 2.mp3", "Chapter 10.mp3"]);
  });

  it("honors explicit part suffixes over plain names", () => {
    const files = ["Book - pt2.m4b", "Book - pt10.m4b", "Book - pt1.m4b"].map((name) => ({ name }));
    expect(names(orderAudioParts(files))).toEqual(["Book - pt1.m4b", "Book - pt2.m4b", "Book - pt10.m4b"]);
  });

  it("keeps zero-padded track numbers in order", () => {
    const files = ["03 - C.mp3", "01 - A.mp3", "02 - B.mp3"].map((name) => ({ name }));
    expect(names(orderAudioParts(files))).toEqual(["01 - A.mp3", "02 - B.mp3", "03 - C.mp3"]);
  });
});

describe("disc folders", () => {
  it("recognizes common disc/part folder names", () => {
    expect(parseDiscFolderNumber("CD1")).toBe(1);
    expect(parseDiscFolderNumber("Disc 2")).toBe(2);
    expect(parseDiscFolderNumber("Part 03")).toBe(3);
    expect(parseDiscFolderNumber("Disk_10")).toBe(10);
    expect(parseDiscFolderNumber("cd 2 - Chapters 11-20")).toBe(2);
  });

  it("does not mistake ordinary folders for discs", () => {
    expect(isDiscFolderName("Partners in Crime")).toBe(false);
    expect(isDiscFolderName("Discworld")).toBe(false);
    expect(isDiscFolderName("The Way of Kings (2010)")).toBe(false);
    expect(isDiscFolderName("Series Name")).toBe(false);
  });

  it("flattens loose files then discs in disc order", () => {
    const f = (name: string) => ({ name });
    const ordered = orderBookParts(
      [f("Intro.mp3")],
      [
        { name: "Disc 10", files: [f("2.mp3"), f("1.mp3")] },
        { name: "Disc 2", files: [f("b.mp3"), f("a.mp3")] },
        { name: "CD1", files: [f("x.mp3")] },
      ]
    );
    expect(ordered.map((x) => x.name)).toEqual(["Intro.mp3", "x.mp3", "a.mp3", "b.mp3", "1.mp3", "2.mp3"]);
  });
});

describe("parseBookFolderName", () => {
  it("extracts name and year", () => {
    expect(parseBookFolderName("Project Hail Mary (2021)")).toEqual({
      name: "Project Hail Mary",
      year: 2021,
      seriesPosition: null,
      asin: null,
      narrators: [],
    });
  });

  it("strips a series position prefix", () => {
    expect(parseBookFolderName("Book 3 - Oathbringer (2017)")).toMatchObject({
      name: "Oathbringer",
      seriesPosition: "3",
      year: 2017,
    });
    expect(parseBookFolderName("01 - Storm Front").seriesPosition).toBe("1");
    expect(parseBookFolderName("Vol. 2.5 - Interlude")).toMatchObject({
      name: "Interlude",
      seriesPosition: "2.5",
    });
    expect(parseBookFolderName("#4: Skyward")).toMatchObject({ name: "Skyward", seriesPosition: "4" });
  });

  it("leaves numeric titles alone", () => {
    expect(parseBookFolderName("1984").name).toBe("1984");
    expect(parseBookFolderName("1984 - Special Edition")).toMatchObject({
      name: "1984 - Special Edition",
      seriesPosition: null,
    });
    expect(parseBookFolderName("2001 A Space Odyssey").seriesPosition).toBeNull();
  });

  it("strips a [Narrator] tag from the folder name, before or after the year", () => {
    expect(parseBookFolderName("Project Hail Mary (2021) [Ray Porter]")).toMatchObject({
      name: "Project Hail Mary",
      year: 2021,
      narrators: ["Ray Porter"],
    });
    expect(parseBookFolderName("Project Hail Mary [Ray Porter] (2021)")).toMatchObject({
      name: "Project Hail Mary",
      year: 2021,
      narrators: ["Ray Porter"],
    });
    expect(parseBookFolderName("Book 2 - Words of Radiance [Michael Kramer]")).toMatchObject({
      name: "Words of Radiance",
      seriesPosition: "2",
      narrators: ["Michael Kramer"],
    });
  });

  it("reads an ASIN tag", () => {
    expect(parseBookFolderName("Dune (1965) {asin-b002v0qk4c}")).toEqual({
      name: "Dune",
      year: 1965,
      seriesPosition: null,
      asin: "B002V0QK4C",
      narrators: [],
    });
  });
});

describe("parseNarratorTag", () => {
  it("reads a trailing [Narrator] and returns the rest", () => {
    expect(parseNarratorTag("Project Hail Mary [Ray Porter]")).toEqual({
      rest: "Project Hail Mary",
      narrators: ["Ray Porter"],
    });
  });

  it("splits several narrators on commas, ampersands and 'and'", () => {
    expect(parseNarratorTag("The Way of Kings [Michael Kramer & Kate Reading]")?.narrators).toEqual([
      "Michael Kramer",
      "Kate Reading",
    ]);
    expect(parseNarratorTag("Book [A. B. Smith, Jane O'Neil and Zoë Ürkel]")?.narrators).toEqual([
      "A. B. Smith",
      "Jane O'Neil",
      "Zoë Ürkel",
    ]);
  });

  it("strips 'Read by' / 'Narrated by' prefixes", () => {
    expect(parseNarratorTag("Dune [Read by Scott Brick]")?.narrators).toEqual(["Scott Brick"]);
    expect(parseNarratorTag("Dune [Narrated by Simon Vance]")?.narrators).toEqual(["Simon Vance"]);
  });

  it("looks past a trailing split marker and keeps it with the rest", () => {
    expect(parseNarratorTag("Title [Ray Porter] - pt2")).toEqual({
      rest: "Title - pt2",
      narrators: ["Ray Porter"],
    });
  });

  it("ignores brackets that aren't narrators", () => {
    expect(parseNarratorTag("Title [Unabridged]")).toBeNull();
    expect(parseNarratorTag("Title [2016]")).toBeNull();
    expect(parseNarratorTag("Title [HQ]")).toBeNull();
    expect(parseNarratorTag("Title [B003P2WO5E]")).toBeNull();
    expect(parseNarratorTag("Title [Disc 1]")).toBeNull();
    expect(parseNarratorTag("No brackets here")).toBeNull();
    expect(parseNarratorTag("[Only brackets]")).toBeNull();
  });

  it("only looks at the end of the name", () => {
    expect(parseNarratorTag("[Ray Porter] Title")).toBeNull();
  });
});

describe("extractNarratorHint", () => {
  it("takes the narrator from the file names", () => {
    expect(extractNarratorHint(["Project Hail Mary [Ray Porter].m4b", "cover.jpg"])).toEqual(["Ray Porter"]);
  });

  it("uses the most common tag across parts", () => {
    expect(
      extractNarratorHint(["a [Ray Porter].mp3", "b [Ray Porter].mp3", "c [Someone Else].mp3"])
    ).toEqual(["Ray Porter"]);
  });

  it("falls back to the folder's tag, then to null", () => {
    expect(extractNarratorHint(["book.m4b"], ["Kate Reading"])).toEqual(["Kate Reading"]);
    expect(extractNarratorHint(["book.m4b"])).toBeNull();
  });
});

describe("remuxed audio variants", () => {
  const originals = [
    "Movie Title (2001).mp4",
    "Movie Title (2001) - pt1.mp4",
    "Show - s01e05 - Title.mp4",
    "Show - s01e01-e06 - pt1.mp4",
    "Mr. Smith Goes (1939).mp4",
  ];

  it.each(originals)("round-trips %s", (name) => {
    const variant = variantFileName(name);
    expect(variant).toBe(name.replace(/\.mp4$/, ".aac.mp4"));
    expect(isBrowserFriendlyVariant(variant)).toBe(true);
    expect(isBrowserFriendlyVariant(name)).toBe(false);
    expect(stripVariantSuffix(variant)).toBe(name);
  });

  it("is case-insensitive", () => {
    expect(isBrowserFriendlyVariant("Movie.AAC.mp4")).toBe(true);
    expect(stripVariantSuffix("Movie.AAC.mp4")).toBe("Movie.mp4");
  });

  it("only matches the tag immediately before the extension", () => {
    expect(isBrowserFriendlyVariant("Movie.aac.cut.mp4")).toBe(false);
    expect(isBrowserFriendlyVariant("Movie.aac")).toBe(false);
    expect(isBrowserFriendlyVariant(".aac.mp4")).toBe(false);
    expect(stripVariantSuffix("Movie.mp4")).toBe("Movie.mp4");
  });

  it("filters variants out of a mixed list before segment ordering", () => {
    const files = [
      { name: "M - pt2.mp4" },
      { name: "M - pt1.aac.mp4" },
      { name: "M - pt1.mp4" },
      { name: "M - pt2.aac.mp4" },
    ];
    const normal = files.filter((f) => !isBrowserFriendlyVariant(f.name));
    expect(orderMediaSegments(normal).map((f) => f.name)).toEqual(["M - pt1.mp4", "M - pt2.mp4"]);
  });

  it("does not disturb episode/part/extra parsing of the original names", () => {
    expect(parseEpisodeFileName("Show - s01e05 - Title.mp4")?.episode).toBe(5);
    expect(isExtraFile("Movie-trailer.mp4")).toBe(true);
  });
});

describe("folderNameWithTmdbId / fileNameWithTmdbId", () => {
  it("appends a tmdb tag to a folder, replacing any id tags", () => {
    expect(folderNameWithTmdbId("The Kid (2000)", 10)).toBe("The Kid (2000) {tmdb-10}");
    expect(folderNameWithTmdbId("The Kid (2000) {imdb-tt0187078}", 10)).toBe("The Kid (2000) {tmdb-10}");
    expect(folderNameWithTmdbId("The Kid (2000) {tmdb-1} {edition-Cut}", 10)).toBe(
      "The Kid (2000) {edition-Cut} {tmdb-10}"
    );
  });

  it("puts the tag right after the year in a file name", () => {
    expect(fileNameWithTmdbId("The Kid (2000).mp4", 10)).toBe("The Kid (2000) {tmdb-10}.mp4");
    expect(fileNameWithTmdbId("The Kid (2000) - pt1.mp4", 10)).toBe("The Kid (2000) {tmdb-10} - pt1.mp4");
    expect(fileNameWithTmdbId("The Kid (2000) {tmdb-99}.mp4", 10)).toBe("The Kid (2000) {tmdb-10}.mp4");
  });

  it("falls back to before the first suffix, or the extension, without a year", () => {
    expect(fileNameWithTmdbId("Home Video - pt2.mp4", 5)).toBe("Home Video {tmdb-5} - pt2.mp4");
    expect(fileNameWithTmdbId("Home Video.mp4", 5)).toBe("Home Video {tmdb-5}.mp4");
  });

  it("keeps a browser-friendly variant round-tripping to its renamed original", () => {
    const original = fileNameWithTmdbId("The Kid (2000).mp4", 10);
    const variant = fileNameWithTmdbId(variantFileName("The Kid (2000).mp4"), 10);
    expect(stripVariantSuffix(variant)).toBe(original);
  });

  it("produces names the parsers still read", () => {
    expect(orderMediaSegments([{ name: fileNameWithTmdbId("A (2000) - pt2.mp4", 1) }, { name: fileNameWithTmdbId("A (2000) - pt1.mp4", 1) }]).map((f) => f.name)).toEqual([
      "A (2000) {tmdb-1} - pt1.mp4",
      "A (2000) {tmdb-1} - pt2.mp4",
    ]);
  });
});

describe("year correction when stamping", () => {
  it("rewrites the folder's year, or adds one", () => {
    expect(folderNameWithTmdbId("The Kid (1921)", 10, 2000)).toBe("The Kid (2000) {tmdb-10}");
    expect(folderNameWithTmdbId("The Kid", 10, 2000)).toBe("The Kid (2000) {tmdb-10}");
    expect(folderNameWithTmdbId("2001: A Space Odyssey (1968) {edition-Cut (1999)}", 3, 1969)).toBe(
      "2001: A Space Odyssey (1969) {edition-Cut (1999)} {tmdb-3}"
    );
  });

  it("leaves the year alone when TMDB has none", () => {
    expect(folderNameWithTmdbId("The Touch (2001)", 1384265, null)).toBe("The Touch (2001) {tmdb-1384265}");
  });

  it("rewrites or adds the year in file names, keeping suffixes", () => {
    expect(fileNameWithTmdbId("The Kid (1921) - pt1.mp4", 10, 2000)).toBe("The Kid (2000) {tmdb-10} - pt1.mp4");
    expect(fileNameWithTmdbId("The Kid.mp4", 10, 2000)).toBe("The Kid (2000) {tmdb-10}.mp4");
    expect(fileNameWithTmdbId("The Kid - pt2.mp4", 10, 2000)).toBe("The Kid (2000) {tmdb-10} - pt2.mp4");
  });
});

describe("resolution versions in file names", () => {
  it("finds the label in a movie or episode name, wherever the part marker sits, and says '' when there is none", () => {
    expect(versionLabelOf("Movie (2020) - 1080p.mp4")).toBe("1080p");
    expect(versionLabelOf("Movie (2020) - 4K.mp4")).toBe("4k");
    expect(versionLabelOf("Movie (2020) - 4K - pt2.mp4")).toBe("4k");
    expect(versionLabelOf("Movie (2020) - pt1 - 720p.mp4")).toBe("720p");
    expect(versionLabelOf("Movie (2020) {tmdb-603} - 1080p BluRay.mp4")).toBe("1080p bluray");
    expect(versionLabelOf("Movie (2020).mp4")).toBe("");
    expect(versionLabelOf("Movie (2020) - pt1.mp4")).toBe("");
  });
  it("is not fooled by titles that merely contain a resolution-like word", () => {
    expect(versionLabelOf("1080p - The Movie.mp4")).toBe(""); // the first segment is the title
    expect(versionLabelOf("Show - s01e01 - Pilot.mp4")).toBe("");
    expect(versionLabelOf("Show - s01e01 - HDR Special.mp4")).toBe("");
    expect(versionLabelOf("Show - s01e01 - 720pfoo.mp4")).toBe("");
    expect(versionLabelOf("Movie - 1080p.aac.mp4")).toBe(""); // a remuxed copy is matched to its original by name, not read as a version
  });
  it("keeps an episode's title and numbers when the name also carries a label", () => {
    expect(parseEpisodeFileName("Show - s01e01 - 1080p.mp4")).toEqual({ season: 1, episode: 1, episodes: [1], name: null, version: "1080p" });
    expect(parseEpisodeFileName("Show - s01e01 - Pilot - 4K.mp4")).toEqual({ season: 1, episode: 1, episodes: [1], name: "Pilot", version: "4k" });
    expect(parseEpisodeFileName("Show - s01e05-e06 - 720p - pt1.mp4")).toMatchObject({ episodes: [5, 6], name: null, version: "720p" });
  });
  it("groups files by version, the unlabelled ones first, keeping each version's parts together", () => {
    const files = [{ name: "M - 4K - pt2.mp4" }, { name: "M - 1080p.mp4" }, { name: "M.mp4" }, { name: "M - 4K - pt1.mp4" }];
    const groups = groupByVersion(files);
    expect([...groups.keys()]).toEqual(["", "1080p", "4k"]);
    expect(groups.get("4k")?.map((f) => f.name)).toEqual(["M - 4K - pt2.mp4", "M - 4K - pt1.mp4"]);
  });
  it("names a resolution from the picture size, counting cropped widescreen as its full-height name", () => {
    expect(resolutionName(1920, 1080)).toBe("1080p");
    expect(resolutionName(1920, 800)).toBe("1080p");
    expect(resolutionName(3840, 1600)).toBe("4K");
    expect(resolutionName(1280, 720)).toBe("720p");
    expect(resolutionName(854, 480)).toBe("480p");
    expect(resolutionName(null, null)).toBeNull();
  });
  it("gives a rough height for a label", () => {
    expect([labelHeightHint("1080p"), labelHeightHint("4k"), labelHeightHint("uhd"), labelHeightHint("720p bluray"), labelHeightHint("sd"), labelHeightHint("x")]).toEqual([1080, 2160, 2160, 720, 480, null]);
  });
});
