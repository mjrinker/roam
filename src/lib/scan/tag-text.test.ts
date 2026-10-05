import { describe, expect, it } from "vitest";
import { cleanTagString } from "./tag-text";

describe("cleanTagString", () => {
  it("collapses whitespace and strips control characters", () => {
    expect(cleanTagString("  Line\u0000one\n\ntwo \t three  ", 100)).toBe("Line one two three");
    expect(cleanTagString("   ", 10)).toBeNull();
    expect(cleanTagString("", 10)).toBeNull();
  });

  it("removes C1 controls, zero-width characters and text-direction overrides that could make one name look like another", () => {
    expect(cleanTagString("abc‮def​⁦ghi\u0085jkl﻿mno", 100)).toBe("abc def ghi jkl mno");
    expect(cleanTagString("‮​⁦", 100)).toBeNull();
  });

  it("cuts by whole characters, never leaving half of an emoji", () => {
    const text = "a".repeat(299) + "😀😀😀"; // the cut falls between two halves of an emoji if done in UTF-16 units
    const cut = cleanTagString(text, 300)!;
    expect(Array.from(cut)).toHaveLength(300);
    expect(cut.endsWith("😀")).toBe(true);
    expect(cut).toBe(cut.toWellFormed()); // no lone surrogate
    expect(() => JSON.stringify([cut])).not.toThrow();
  });

  it("replaces lone surrogates so the value is always safe to store", () => {
    const cleaned = cleanTagString("bad\ud800tag", 100)!;
    expect(cleaned).toBe(cleaned.toWellFormed());
    expect(cleaned).toContain("bad");
    expect(JSON.parse(JSON.stringify([cleaned]))[0]).toBe(cleaned);
  });
});
