import { describe, expect, it } from "vitest";
import { bookCredits, contributorHref, groupAuthors, personKey } from "./credits";
import { initialsOf, parseAudiobookView } from "@/components/library/audiobook-views";

const book = (over: Partial<{ authors: string[] | null; narrators: string[] | null; folderAuthor: string | null; posterUrl: string | null }> = {}) => ({ authors: null, narrators: null, folderAuthor: null, posterUrl: null, ...over });

describe("who is credited on an audiobook", () => {
  it("compares names without regard to case or spacing", () => {
    expect(personKey("  Stephen   KING ")).toBe("stephen king");
  });
  it("takes the authors, else the folder it was found under, and the narrators, each person once", () => {
    expect(bookCredits(book({ authors: ["A One", "a  one", "B Two"], narrators: ["N Narrator", "n narrator"] }))).toEqual({ authors: ["A One", "B Two"], narrators: ["N Narrator"] });
    expect(bookCredits(book({ authors: [], folderAuthor: "Folder Person" }))).toEqual({ authors: ["Folder Person"], narrators: [] });
    expect(bookCredits(book({ authors: ["Real Author"], folderAuthor: "Folder Person" })).authors).toEqual(["Real Author"]);
    expect(bookCredits(book())).toEqual({ authors: [], narrators: [] });
  });
  it("groups books by author A to Z with counts and a cover, spelling variants together", () => {
    const tiles = groupAuthors([
      book({ authors: ["Zed Writer"], posterUrl: "z.jpg" }),
      book({ authors: ["Amy Author", "Zed Writer"], posterUrl: "a.jpg" }),
      book({ authors: ["amy author"], posterUrl: null }),
      book({ folderAuthor: "Folk Name", posterUrl: "f.jpg" }),
      book({}),
    ]);
    expect(tiles.map((t) => [t.name, t.books, t.coverUrl])).toEqual([["Amy Author", 2, "a.jpg"], ["Folk Name", 1, "f.jpg"], ["Zed Writer", 2, "z.jpg"]]);
  });
  it("links a person by name, safely encoded", () => {
    expect(contributorHref("s1", "Anne O'Brien / Co")).toBe("/s/s1/contributor/Anne%20O'Brien%20%2F%20Co");
  });
  it("shows initials for a name, and knows its two views", () => {
    expect([initialsOf("Stephen King"), initialsOf("Cher"), initialsOf("Mary Jane Watson"), initialsOf("  "), initialsOf("J. R. R. Tolkien")]).toEqual(["SK", "C", "MW", "?", "JT"]);
    expect([parseAudiobookView("authors"), parseAudiobookView("books"), parseAudiobookView(null), parseAudiobookView("junk")]).toEqual(["authors", "books", "books", "books"]);
  });
});
