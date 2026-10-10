import { describe, expect, it } from "vitest";
import { groupSongs, UNKNOWN_GROUP, type SongRow } from "./audio-groups";

const song = (id: string, over: Partial<SongRow> = {}): SongRow => ({ id, authors: null, seriesName: null, genres: null, posterUrl: null, ...over });

describe("groupSongs", () => {
  it("groups by the first artist ignoring case and edge spaces, counts, shows the best spelling (the most common, then mixed case) and the first picture, and puts unknown last", () => {
    const groups = groupSongs(
      [song("1", { authors: ["Zed", "Guest"], posterUrl: "z.jpg" }), song("2", { authors: ["  mia "] }), song("3", { authors: ["ZED"], posterUrl: "later.jpg" }), song("4"), song("5", { authors: ["Mia"], posterUrl: "m.jpg" })],
      "artist"
    );
    expect(groups.map((g) => [g.label, g.count, g.coverUrl])).toEqual([["Mia", 2, "m.jpg"], ["Zed", 2, "z.jpg"], ["Unknown artist", 1, null]]);
    expect(groups[2].name).toBe(UNKNOWN_GROUP);
  });
  it("shows the most common spelling, whatever order the songs come in", () => {
    const rows = [song("1", { authors: ["M83"] }), song("2", { authors: ["m83"] }), song("3", { authors: ["m83"] })];
    expect(groupSongs(rows, "artist")[0].label).toBe("m83");
    expect(groupSongs([...rows].reverse(), "artist")[0].label).toBe("m83");
    expect(groupSongs([song("1", { authors: ["M83"] }), song("2", { authors: ["m83"] })], "artist")[0].label).toBe("M83");
    expect(groupSongs([song("1", { authors: ["ZED"] }), song("2", { authors: ["Zed"] })], "artist")[0].label).toBe("Zed");
  });
  it("groups by album, A to Z with numbers by value", () => {
    const groups = groupSongs([song("1", { seriesName: "Vol 10" }), song("2", { seriesName: "Vol 2" }), song("3", { seriesName: "vol 2" }), song("4", { seriesName: " " })], "album");
    expect(groups.map((g) => [g.label, g.count])).toEqual([["Vol 2", 2], ["Vol 10", 1], ["Unknown album", 1]]);
  });
  it("puts a song in every one of its genres, once each, and the genre-less ones under unknown", () => {
    const groups = groupSongs([song("1", { genres: ["Rock", "Pop", "rock"] }), song("2", { genres: ["Pop"] }), song("3", { genres: [] }), song("4", { genres: null })], "genre");
    expect(groups.map((g) => [g.label, g.count])).toEqual([["Pop", 2], ["Rock", 1], ["Unknown genre", 2]]);
  });
  it("is empty for no songs", () => {
    expect(groupSongs([], "artist")).toEqual([]);
  });
});
