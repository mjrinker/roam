import { describe, expect, it } from "vitest";
import { genreFromIndex, MAX_GENRES, normalizeGenres } from "./genres";

describe("genreFromIndex", () => {
  it("names the standard and Winamp genres, and nothing else", () => {
    expect([genreFromIndex(0), genreFromIndex(17), genreFromIndex(79), genreFromIndex(80), genreFromIndex(125)]).toEqual(["Blues", "Rock", "Hard Rock", "Folk", "Dance Hall"]);
    expect([genreFromIndex(126), genreFromIndex(255), genreFromIndex(-1), genreFromIndex(1.5)]).toEqual([null, null, null, null]);
  });
});

describe("normalizeGenres", () => {
  it("reads plain text, numbers and (number) references", () => {
    expect(normalizeGenres(["Jazz"])).toEqual(["Jazz"]);
    expect(normalizeGenres(["17"])).toEqual(["Rock"]);
    expect(normalizeGenres(["(17)"])).toEqual(["Rock"]);
    expect(normalizeGenres(["(17)Rock"])).toEqual(["Rock"]);
    expect(normalizeGenres(["(9)(13)"])).toEqual(["Metal", "Pop"]);
    expect(normalizeGenres(["(17)Classic Rock"])).toEqual(["Rock", "Classic Rock"]);
    expect(normalizeGenres(["(RX)", "(CR)"])).toEqual([]);
    expect(normalizeGenres(["(999)"])).toEqual([]);
  });
  it("splits ; lists, joins several fields, drops repeats ignoring case, and skips junk", () => {
    expect(normalizeGenres(["Rock; Pop;rock"])).toEqual(["Rock", "Pop"]);
    expect(normalizeGenres(["Rock", "pop", "ROCK"])).toEqual(["Rock", "pop"]);
    expect(normalizeGenres(["Unknown", "", "  ", "Genre"])).toEqual([]);
    expect(normalizeGenres(["R&B/Soul"])).toEqual(["R&B/Soul"]); // a slash is part of a name
  });
  it("keeps a bounded number, each of bounded length, with control characters removed", () => {
    expect(normalizeGenres(["A;B;C;D;E;F;G"])).toHaveLength(MAX_GENRES);
    expect(normalizeGenres(["x".repeat(500)])[0].length).toBeLessThanOrEqual(60);
    expect(normalizeGenres(["Ro\u0000ck\u0007"])).toEqual(["Ro ck"]); // control characters become spaces, as in every tag text
  });
});
