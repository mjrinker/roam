import { describe, expect, it } from "vitest";
import { EXTRAS_CREDITS, EXTRAS_ORDER, groupedCredits } from "./extras-credits";

/** The only terms the demo's extras may be under: dedicated to the public domain, or CC0. */
const ALLOWED_LICENCES = new Set(["CC0", "CC0 1.0", "Public domain", "Public domain (USA); Project Gutenberg"]);
const ALLOWED_SOURCES = [/^https:\/\/commons\.wikimedia\.org\/wiki\//, /^https:\/\/archive\.org\/details\//, /^https:\/\/www\.gutenberg\.org\/ebooks\/\d+$/];

describe("the demo's credits for photos, music, audiobooks and books", () => {
  it("has entries for every kind of content, and nothing under an unknown heading", () => {
    expect(EXTRAS_CREDITS.length).toBeGreaterThan(200);
    for (const library of EXTRAS_ORDER) expect(EXTRAS_CREDITS.some((c) => c.library === library), library).toBe(true);
    expect(EXTRAS_CREDITS.every((c) => EXTRAS_ORDER.includes(c.library))).toBe(true);
  });
  it("lists only public-domain and CC0 material from the places the seeding script takes things from", () => {
    for (const c of EXTRAS_CREDITS) {
      expect(ALLOWED_LICENCES.has(c.licence), `${c.name}: ${c.licence}`).toBe(true);
      expect(ALLOWED_SOURCES.some((re) => re.test(c.source)), `${c.name}: ${c.source}`).toBe(true);
      expect(c.name.trim()).not.toBe("");
      expect(c.author.trim()).not.toBe("");
    }
  });
  it("credits each item once, and groups in a fixed order", () => {
    const keys = EXTRAS_CREDITS.map((c) => `${c.library}/${c.name}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(groupedCredits().map((g) => g.library)).toEqual(EXTRAS_ORDER);
    expect(groupedCredits([]).length).toBe(0);
  });
});
