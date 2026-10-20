/**
 * Plex's own naming documents, as examples: every file and folder name they show must be read the way they say. This is the contract for
 * "bring a library you already have for Plex, and it works": the examples below are copied from support.plex.tv's articles on naming and
 * organizing movie, TV show and music files, local trailers and extras, multiple versions and editions, subtitles, and match hints.
 */
import { describe, expect, it } from "vitest";
import { extraCategoryOfFile, extraCategoryOfFolder, extraDisplayName } from "@/lib/extras/categories";
import { subtitleFileParts } from "@/lib/scan/subtitle-names";
import { sidecarsFor, videoBaseNames } from "@/lib/subtitles/tracks";
import {
  groupEpisodeFiles,
  groupMovieVersions,
  isExtraFile,
  isUnplayableVideo,
  isVideoFile,
  movieVersionLabel,
  orderMediaSegments,
  parseEditionTag,
  parseEpisodeAirDate,
  parseEpisodeFileName,
  parseMovieFileTitle,
  parseSeasonFolderName,
  parseTitleFolderName,
} from "./conventions";
import { hintForFile, parsePlexMatch } from "./plexmatch";

const file = (name: string, id = name) => ({ id, name, kind: "file" as const });
const folder = (name: string, id = name) => ({ id, name, kind: "folder" as const });

describe("Movies: Plex's naming and organizing article", () => {
  it("MovieName (release year), in a folder or stand-alone", () => {
    for (const name of ["Avatar (2009)", "Batman Begins (2005)"]) {
      const { name: n, year } = parseTitleFolderName(name);
      expect(year).toBe(Number(/\((\d{4})\)/.exec(name)![1]));
      expect(name.startsWith(n)).toBe(true);
    }
    expect(parseMovieFileTitle("Avatar (2009).mkv")).toMatchObject({ name: "Avatar", year: 2009 });
    expect(parseMovieFileTitle("Batman Begins (2005).mp4")).toMatchObject({ name: "Batman Begins", year: 2005 });
  });
  it("{imdb-...} and {tmdb-...} ids, in the folder and the file", () => {
    expect(parseTitleFolderName("Batman Begins (2005) {imdb-tt0372784}")).toMatchObject({ name: "Batman Begins", year: 2005, imdbId: "tt0372784" });
    expect(parseTitleFolderName("Batman Begins (2005) {tmdb-272}")).toMatchObject({ name: "Batman Begins", year: 2005, tmdbId: 272 });
    expect(parseMovieFileTitle("Batman Begins (2005) {imdb-tt0372784}.mp4")).toMatchObject({ name: "Batman Begins", year: 2005, imdbId: "tt0372784" });
    expect(parseMovieFileTitle("Batman Begins (2005) {tmdb-272}.mp4")).toMatchObject({ tmdbId: 272 });
  });
  it("{edition-...}, in the folder, the file or both, in any order with an id", () => {
    expect(parseTitleFolderName("Blade Runner (1982) {edition-Director's Cut}")).toMatchObject({ name: "Blade Runner", year: 1982, edition: "Director's Cut" });
    expect(parseTitleFolderName("Blade Runner (1982) {edition-Final Cut} {tmdb-78}")).toMatchObject({ edition: "Final Cut", tmdbId: 78 });
    expect(parseTitleFolderName("Blade Runner (1982) {tmdb-78} {edition-Final Cut}")).toMatchObject({ edition: "Final Cut", tmdbId: 78 });
    expect(parseEditionTag("Blade Runner (1982) {edition-Final Cut}.mkv")).toBe("Final Cut");
    expect(parseMovieFileTitle("Blade Runner (1982) {edition-Director's Cut}.mp4")).toMatchObject({ name: "Blade Runner", year: 1982, edition: "Director's Cut" });
    expect(parseMovieFileTitle("Blade Runner (1982).mp4").edition).toBeNull();
  });
  it("split files: cdX, discX, diskX, dvdX, partX, ptX", () => {
    const names = ["cd", "disc", "disk", "dvd", "part", "pt"].flatMap((w) => [`The Dark Knight (2008) - ${w}2.mp4`, `The Dark Knight (2008) - ${w}1.mp4`]);
    for (const w of ["cd", "disc", "disk", "dvd", "part", "pt"]) {
      const ordered = orderMediaSegments([file(`The Dark Knight (2008) - ${w}2.mp4`), file(`The Dark Knight (2008) - ${w}1.mp4`)]);
      expect(ordered.map((f) => f.name)).toEqual([`The Dark Knight (2008) - ${w}1.mp4`, `The Dark Knight (2008) - ${w}2.mp4`]);
    }
    // The parts of one movie are one version, in order, and a part marker is not a version.
    expect([...groupMovieVersions(names.slice(0, 2).map((n) => file(n))).keys()]).toEqual([""]);
    expect(movieVersionLabel("The Dark Knight (2008) - pt1.mp4")).toBe("");
  });
  it("the folder holds only the movie, its parts and its extras, subtitles and artwork", () => {
    expect(isVideoFile("Avatar (2009).mp4")).toBe(true);
    expect(isVideoFile("poster.jpg")).toBe(false);
    expect(isVideoFile("Avatar (2009).en.srt")).toBe(false);
  });
});

describe("Multiple versions: Movie (Year) - ArbitraryText.ext", () => {
  it("the text can be anything useful, so different texts are different versions, never parts of one", () => {
    const g = groupMovieVersions([file("Pulp Fiction (1994) - 1080p.mkv"), file("Pulp Fiction (1994) - SD.m4v")]);
    expect([...g.keys()].sort()).toEqual(["1080p", "sd"]);
    const odd = groupMovieVersions([file("Heat (1995).mp4"), file("Heat (1995) - Hevc.mp4"), file("Heat (1995) - for the phone.mp4")]);
    expect([...odd.keys()]).toEqual(["", "for the phone", "hevc"]);
  });
  it("a version can itself be split", () => {
    const g = groupMovieVersions([file("Heat (1995) - 1080p - pt1.mp4"), file("Heat (1995) - 1080p - pt2.mp4"), file("Heat (1995) - 720p - pt1.mp4")]);
    expect(g.get("1080p")).toHaveLength(2);
    expect(g.get("720p")).toHaveLength(1);
  });
  it("versions of an edition, written with dots: Blade Runner (1982).1080p.h264 {edition-Director's Cut}.mp4", () => {
    expect(movieVersionLabel("Blade Runner (1982).1080p.h264 {edition-Director's Cut}.mp4")).toBe("1080p h264");
    expect(movieVersionLabel("Blade Runner (1982).4k.hevc {edition-Director's Cut}.mkv")).toBe("4k hevc");
    expect(movieVersionLabel("Blade Runner (1982) {edition-Director's Cut}.mp4")).toBe("");
    expect(parseMovieFileTitle("Blade Runner (1982).1080p.h264 {edition-Director's Cut}.mp4")).toMatchObject({ name: "Blade Runner", year: 1982, edition: "Director's Cut" });
  });
});

describe("TV shows: Plex's naming and organizing article", () => {
  it("show folders carry the year and id tags", () => {
    expect(parseTitleFolderName("Band of Brothers (2001)")).toMatchObject({ name: "Band of Brothers", year: 2001 });
    expect(parseTitleFolderName("ShowName (2020) {tmdb-123456}").tmdbId).toBe(123456);
    expect(parseTitleFolderName("ShowName (2020) {tvdb-123456}").tvdbId).toBe(123456);
    expect(parseTitleFolderName("ShowName (2020) {imdb-tt123456}").imdbId).toBe("tt123456");
    expect(parseTitleFolderName("The Office (UK) (2001) {tmdb-2996}")).toMatchObject({ name: "The Office (UK)", year: 2001, tmdbId: 2996 });
    expect(parseTitleFolderName("The Office (US) (2005) {tvdb-73244}")).toMatchObject({ name: "The Office (US)", tvdbId: 73244 });
    expect(parseTitleFolderName(" The Office (US) (2005) {tvdb-73244}").name).toBe("The Office (US)");
  });
  it("season folders: Season 01, Season 1, Season 00 and Specials", () => {
    expect(parseSeasonFolderName("Season 01")).toBe(1);
    expect(parseSeasonFolderName("Season 02")).toBe(2);
    expect(parseSeasonFolderName("Season 08")).toBe(8);
    expect(parseSeasonFolderName("Season 00")).toBe(0);
    expect(parseSeasonFolderName("Specials")).toBe(0);
    expect(parseSeasonFolderName("specials")).toBe(0);
    expect(parseSeasonFolderName("Season 1")).toBe(1);
  });
  it("sXXeXX, with dashes, dots or spaces; the rest is optional info", () => {
    const at = (name: string) => parseEpisodeFileName(name);
    expect(at("ShowName – s02e17 – Optional_Info.mp4")).toMatchObject({ season: 2, episode: 17 });
    expect(at("ShowName - s02e17 - Optional_Info.mp4")).toMatchObject({ season: 2, episode: 17, name: "Optional_Info" });
    expect(at("ShowName.s02e17.mp4")).toMatchObject({ season: 2, episode: 17 });
    expect(at("ShowName s02e17.mp4")).toMatchObject({ season: 2, episode: 17 });
    expect(at("Show.Name.S02E17.720p.WEB-DL.H264-GRP.mp4")).toMatchObject({ season: 2, episode: 17, name: null });
    expect(at("Doctor Who (1963) - s01e01 - An Unearthly Child (1).mp4")).toMatchObject({ season: 1, episode: 1, name: "An Unearthly Child (1)" });
    expect(at("From the Earth to the Moon (1998) - s01e01.mp4")).toMatchObject({ season: 1, episode: 1, name: null });
    expect(at("Grey's Anatomy (2005) - s00e01 - Straight to the Heart.mp4")).toMatchObject({ season: 0, episode: 1, name: "Straight to the Heart" });
    expect(at("The Office (US) - s01e01 - Pilot.mp4")).toMatchObject({ season: 1, episode: 1, name: "Pilot" });
  });
  it("optional info in [brackets] is ignored (the TV Series agent uses the rest as a hint)", () => {
    expect(parseEpisodeFileName("Band of Brothers (2001) - s01e01 - Currahee [1080p Bluray].mp4")).toMatchObject({ season: 1, episode: 1, name: "Currahee" });
    expect(parseEpisodeFileName("Band of Brothers (2001) - s01e01 [1080p Bluray].mp4")).toMatchObject({ season: 1, episode: 1, name: null });
  });
  it("date-based shows: YYYY-MM-DD or DD-MM-YYYY, with dashes, periods or spaces", () => {
    expect(parseEpisodeAirDate("The Colbert Report (2005) - 2011-11-15 - Elijah Wood.mp4")).toBe("2011-11-15");
    expect(parseEpisodeAirDate("ShowName – 15-11-2011 – Optional_Info.mp4")).toBe("2011-11-15");
    expect(parseEpisodeAirDate("ShowName - 2011.11.15 - Guest.mp4")).toBe("2011-11-15");
    expect(parseEpisodeAirDate("ShowName - 2011 11 15 - Guest.mp4")).toBe("2011-11-15");
    expect(parseEpisodeAirDate("ShowName - 15.11.2011.mp4")).toBe("2011-11-15");
    expect(parseEpisodeAirDate("ShowName - 31-02-2011.mp4")).toBeNull();
    // A name with an episode number is numbered by it.
    expect(parseEpisodeAirDate("Show (2005) - s01e02 - 2011-11-15.mp4")).toBeNull();
    expect(parseEpisodeFileName("The Colbert Report (2005) - 2011-11-15 - Elijah Wood.mp4")).toBeNull();
  });
  it("multiple episodes in one file: s02e18-e19", () => {
    expect(parseEpisodeFileName("Grey's Anatomy (2005) - s02e01-e03.avi")).toMatchObject({ season: 2, episodes: [1, 2, 3] });
    expect(parseEpisodeFileName("ShowName – s02e18-e19 – Optional_Info.mp4")).toMatchObject({ season: 2, episodes: [18, 19], name: "Optional_Info" });
  });
  it("episodes split across files: Grey's s01e01 - pt1 / pt2", () => {
    const g = groupEpisodeFiles([file("Grey's Anatomy (2005) - s01e01 - pt1.mp4"), file("Grey's Anatomy (2005) - s01e01 - pt2.mp4"), file("Grey's Anatomy (2005) - s01e02 - The First Cut is the Deepest.mp4"), file("Grey's Anatomy (2005) - s01e03.mp4")]);
    expect([...g.keys()]).toEqual([1, 2, 3]);
    expect(g.get(1)!.files.map((f) => f.name)).toEqual(["Grey's Anatomy (2005) - s01e01 - pt1.mp4", "Grey's Anatomy (2005) - s01e01 - pt2.mp4"]);
    for (const w of ["cd", "disc", "disk", "dvd", "part", "pt"]) {
      expect(groupEpisodeFiles([file(`Show - s02e17 - ${w}1.mp4`), file(`Show - s02e17 - ${w}2.mp4`)]).get(17)!.files).toHaveLength(2);
    }
  });
  it("versions of an episode: Show - s01e01 - 1080p", () => {
    expect(parseEpisodeFileName("Show - s01e01 - 1080p.mp4")).toMatchObject({ season: 1, episode: 1, version: "1080p", name: null });
  });
});

describe("Local trailers and extras", () => {
  const suffixes = ["behindthescenes", "deleted", "featurette", "interview", "scene", "short", "trailer", "other"];
  it("inline: Descriptive_Name-Extra_Type.ext, for every type Plex lists", () => {
    for (const s of suffixes) {
      expect(isExtraFile(`Something-${s}.mp4`), s).toBe(true);
      expect(extraCategoryOfFile(`Something-${s}.mkv`), s).not.toBeNull();
    }
    for (const n of ["Arrival-scene.mp4", "Bar Fight-deleted.mp4", "Performance Capture-behindthescenes.mkv", "Sigourney Weaver-interview.mp4", "Teaser Trailer-trailer.mp4", "Theatrical Trailer #1-trailer.mp4", "Theatrical Trailer #2-trailer.avi"]) expect(isExtraFile(n), n).toBe(true);
    expect(extraDisplayName("Theatrical Trailer #1-trailer.mp4")).toBe("Theatrical Trailer #1");
    // A hyphen with a space after it is not the suffix, and the movie itself is not an extra.
    expect(isExtraFile("Avatar (2009).mkv")).toBe(false);
    expect(isExtraFile("Avatar (2009) - trailer.mp4")).toBe(false);
  });
  it("subfolders, for every name Plex lists", () => {
    for (const f of ["Behind The Scenes", "Deleted Scenes", "Featurettes", "Interviews", "Scenes", "Shorts", "Trailers", "Other"]) expect(extraCategoryOfFolder(f), f).not.toBeNull();
  });
  it("episode extras beside the episode, and several of one type with a number: -deleted1, -deleted2", () => {
    expect(isExtraFile("Game of Thrones - S01E01 - Winter is Coming-deleted.mkv")).toBe(true);
    expect(isExtraFile("Game of Thrones - S01E01 - Winter is Coming-featurette.mkv")).toBe(true);
    for (const n of [1, 2, 3]) {
      expect(isExtraFile(`Game of Thrones - S01E01 - Winter is Coming-deleted${n}.mkv`)).toBe(true);
      expect(extraCategoryOfFile(`Game of Thrones - S01E01 - Winter is Coming-deleted${n}.mkv`)).toBe("deleted");
    }
    expect(extraDisplayName("Game of Thrones - S01E01 - Winter is Coming-deleted2.mkv")).toBe("Game of Thrones - S01E01 - Winter is Coming");
    // The episode itself still numbers as itself.
    expect(parseEpisodeFileName("Game of Thrones - S01E01 - Winter is Coming.mkv")).toMatchObject({ season: 1, episode: 1 });
  });
});

describe("Subtitles", () => {
  it("Movie (Year).[language].ext, in ISO 639-1 and 639-2 codes, with forced, sdh and cc", () => {
    expect(subtitleFileParts("Avatar (2009).en.srt")).toMatchObject({ base: "Avatar (2009)", language: "en", forced: false });
    expect(subtitleFileParts("Avatar (2009).eng.srt")).toMatchObject({ language: "eng" });
    expect(subtitleFileParts("Avatar (2009).en.forced.ass")).toMatchObject({ base: "Avatar (2009)", language: "en", forced: true });
    expect(subtitleFileParts("Avatar (2009).en.sdh.srt")).toMatchObject({ base: "Avatar (2009)", language: "en" });
    expect(subtitleFileParts("Avatar (2009).en.cc.srt")).toMatchObject({ base: "Avatar (2009)", language: "en" });
    expect(subtitleFileParts("Avatar (2009).de.sdh.srt")).toMatchObject({ language: "de" });
    expect(subtitleFileParts("Avatar (2009).srt")).toMatchObject({ base: "Avatar (2009)", language: null });
  });
  it("every format Plex reads: SRT, SMI, SSA, ASS, WebVTT", () => {
    for (const ext of ["srt", "smi", "ssa", "ass", "vtt"]) expect(subtitleFileParts(`Absolutely Fabulous - s02e03.eng.${ext}`), ext).toMatchObject({ base: "Absolutely Fabulous - s02e03", language: "eng" });
    expect(subtitleFileParts("Absolutely Fabulous - s02e03.en.forced.smi")).toMatchObject({ forced: true, language: "en" });
    expect(subtitleFileParts("notes.txt")).toBeNull();
  });
  it("go with the video of the same name, including a version's and a part's", () => {
    expect(videoBaseNames("Avatar (2009).mkv")).toContain("avatar (2009)");
    const found = sidecarsFor([file("Avatar (2009).mp4"), file("Avatar (2009).en.srt"), file("Avatar (2009).en.forced.ass"), file("Avatar (2009).de.sdh.vtt")]);
    expect(found).toHaveLength(1);
    expect(found[0].subtitles).toHaveLength(3);
  });
});

describe("Unplayable video formats are known, not mistaken for missing", () => {
  it("names the formats Plex plays that a browser can't", () => {
    for (const f of ["a.mkv", "a.avi", "a.wmv", "a.ts", "a.m2ts", "a.flv", "a.mpg", "a.MKV"]) expect(isUnplayableVideo(f), f).toBe(true);
    for (const f of ["a.mp4", "a.m4v", "a.mov", "a.srt", "a"]) expect(isUnplayableVideo(f), f).toBe(false);
  });
});

describe(".plexmatch", () => {
  const text = `# This directory contains the second season of Cool Show
Title: Cool Show
Year: 2018
Season: 2
TMDBID: 12345
tvdbid: 777
imdbid: 1234567
Episode: 01: Pilot.mkv
ep: 12: Episode 12 - Finale Part 2.mkv
ep: SP01: Some Unnumbered Special.mkv
ep: SP02: Season 1/Bonus/Bonus Clip 1.mkv
ep: S03E04: weird.mkv
ep: 01-02: both.mkv
Pattern: Bonus/Bonus {sp,1-3,+4}.mp4
Pattern: Bonus/Bonus {sp,4-6,+6}.mp4
Pattern: Show Part {se} - {ep} - *
`;
  const m = parsePlexMatch(text);
  it("reads the series and season hints, names in any case, comments and blank lines ignored", () => {
    expect(m).toMatchObject({ title: "Cool Show", year: 2018, season: 2, tmdbId: 12345, tvdbId: 777, imdbId: "tt1234567" });
    expect(parsePlexMatch("show: Other\n  YEAR :  1999  \n\n#x\n")).toMatchObject({ title: "Other", year: 1999 });
  });
  it("numbers the file an episode hint names, specials as season 0, a path from the series folder, and a range", () => {
    expect(hintForFile(m, "Pilot.mkv")).toEqual({ season: null, episodes: [1] });
    expect(hintForFile(m, "Episode 12 - Finale Part 2.mkv")).toEqual({ season: null, episodes: [12] });
    expect(hintForFile(m, "Some Unnumbered Special.mkv")).toEqual({ season: 0, episodes: [1] });
    expect(hintForFile(m, "Season 1/Bonus/Bonus Clip 1.mkv")).toEqual({ season: 0, episodes: [2] });
    expect(hintForFile(m, "weird.mkv")).toEqual({ season: 3, episodes: [4] });
    expect(hintForFile(m, "both.mkv")).toEqual({ season: null, episodes: [1, 2] });
    expect(hintForFile(m, "nothing.mkv")).toBeNull();
  });
  it("matches patterns: tokens, validity ranges, offsets, wildcards, the earliest pattern winning", () => {
    expect(hintForFile(m, "Bonus/Bonus 2.mp4")).toEqual({ season: 0, episodes: [6] });
    expect(hintForFile(m, "Bonus/Bonus 5.mp4")).toEqual({ season: 0, episodes: [11] });
    expect(hintForFile(m, "Bonus/Bonus 9.mp4")).toBeNull();
    expect(hintForFile(m, "Show Part 3 - 14 - Whatever it is.mkv")).toEqual({ season: 3, episodes: [14] });
  });
  it("{see} is season and episode together", () => {
    const see = parsePlexMatch("pt: Show {see}.mkv");
    expect(hintForFile(see, "Show 214.mkv")).toEqual({ season: 2, episodes: [14] });
  });
});

describe("poster file names", async () => {
  const { posterFile, MOVIE_POSTER_NAMES, SHOW_POSTER_NAMES } = await import("./poster-names");
  it("movies: cover, default, folder, movie, poster (and numbered extras), or a picture named like the movie", () => {
    for (const n of MOVIE_POSTER_NAMES) expect(posterFile([file(`${n}.jpg`)], MOVIE_POSTER_NAMES)?.name).toBe(`${n}.jpg`);
    expect(posterFile([file("poster-2.png"), file("poster.jpg")], MOVIE_POSTER_NAMES)?.name).toBe("poster.jpg");
    expect(posterFile([file("poster-2.png"), file("poster-1.tbn")], MOVIE_POSTER_NAMES)?.name).toBe("poster-1.tbn");
    expect(posterFile([file("Batman Begins (2005)-1.jpg"), file("Batman Begins (2005)-2.tbn")], [], ["Batman Begins (2005)"])?.name).toBe("Batman Begins (2005)-1.jpg");
    expect(posterFile([file("Avatar (2009).jpg")], [], ["Avatar (2009)"])?.name).toBe("Avatar (2009).jpg");
    expect(posterFile([file("fanart.jpg"), file("clearlogo.png")], MOVIE_POSTER_NAMES)).toBeNull();
  });
  it("shows: folder, poster, show", () => {
    for (const n of SHOW_POSTER_NAMES) expect(posterFile([file(`${n}.png`)], SHOW_POSTER_NAMES)?.name).toBe(`${n}.png`);
    expect(posterFile([file("cover.jpg")], SHOW_POSTER_NAMES)).toBeNull();
  });
});
