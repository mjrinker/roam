import { describe, expect, it } from "vitest";
import { SINGLES_ALBUM, UNKNOWN_ARTIST, artistSortKey, nameKey, parseTrackFileName, placeTrack } from "./placement";

describe("parseTrackFileName", () => {
  it.each([
    ["01 - Intro.mp3", { track: 1, disc: null, title: "Intro" }],
    ["01. Intro.mp3", { track: 1, disc: null, title: "Intro" }],
    ["01 Intro.mp3", { track: 1, disc: null, title: "Intro" }],
    ["7) Seven.m4a", { track: 7, disc: null, title: "Seven" }],
    ["105 - Big Number.mp3", { track: 105, disc: null, title: "Big Number" }],
    ["1-05 Intro.mp3", { track: 5, disc: 1, title: "Intro" }],
    ["2-12 - Outro.mp3", { track: 12, disc: 2, title: "Outro" }],
    ["Disc 2 - 05 - Intro.mp3", { track: 5, disc: 2, title: "Intro" }],
    ["CD1-03 Intro.mp3", { track: 3, disc: 1, title: "Intro" }],
    ["Intro.mp3", { track: null, disc: null, title: "Intro" }],
    ["1984.mp3", { track: null, disc: null, title: "1984" }],
    ["99 Luftballons.mp3", { track: 99, disc: null, title: "Luftballons" }], // inherent ambiguity; a title tag overrides
    ["01 - 02.mp3", { track: 1, disc: null, title: "02" }],
    ["01 -.mp3", { track: null, disc: null, title: "01 -" }],
  ])("%s", (name, expected) => {
    expect(parseTrackFileName(name)).toEqual(expected);
  });
});

describe("placeTrack", () => {
  const p = (folderPath: string, fileName = "01 - Song.mp3", tagArtist?: string | null) => placeTrack({ folderPath, fileName, tagArtist });
  it("takes artist and album from the first two folders", () => {
    expect(p("Chopin/Ballades")).toEqual({ artist: "Chopin", album: "Ballades", disc: null, track: 1, title: "Song" });
  });
  it("reads a disc from a disc folder, which wins over a disc written in the file name", () => {
    expect(p("Artist/Album/CD2", "05 Song.mp3")).toMatchObject({ artist: "Artist", album: "Album", disc: 2, track: 5 });
    expect(p("Artist/Album/Disc 3", "1-05 Song.mp3").disc).toBe(3);
    expect(p("Artist/Album", "2-05 Song.mp3").disc).toBe(2);
  });
  it("keeps tracks in any other deeper folder (bonus, extras) in the album", () => {
    expect(p("Artist/Album/Bonus")).toMatchObject({ artist: "Artist", album: "Album", disc: null });
  });
  it("files a track straight in an artist's folder as a single", () => {
    expect(p("Artist")).toMatchObject({ artist: "Artist", album: SINGLES_ALBUM });
  });
  it("credits a track in the library's root to its tagged artist, else to nobody known", () => {
    expect(p("", "x.mp3", "  Someone ")).toMatchObject({ artist: "Someone", album: SINGLES_ALBUM });
    expect(p("", "x.mp3", null).artist).toBe(UNKNOWN_ARTIST);
    expect(p("", "x.mp3", "   ").artist).toBe(UNKNOWN_ARTIST);
  });
  it("ignores empty path segments and keeps the folder names as written", () => {
    expect(p("/Artist//Album/")).toMatchObject({ artist: "Artist", album: "Album" });
  });
});

describe("sort and match keys", () => {
  it("sorts 'The Beatles' under B and leaves a lone 'The' alone", () => {
    expect(artistSortKey("The Beatles")).toBe("beatles");
    expect(artistSortKey("A Tribe Called Quest")).toBe("tribe called quest");
    expect(artistSortKey("The")).toBe("the");
    expect(artistSortKey("Theory of a Deadman")).toBe("theory of a deadman");
  });
  it("matches spellings that differ only in case or spacing", () => {
    expect(nameKey("  Abbey   Road ")).toBe(nameKey("abbey road"));
    expect(nameKey("Abbey Road")).not.toBe(nameKey("Abbey Rd"));
  });
});
