import { describe, expect, it } from "vitest";
import { DEFAULT_FONT_INDEX, FONT_SIZES, clampFontIndex, placeKey, validCfi } from "./reader";

describe("reader rules", () => {
  it("keeps the font size inside the list, and falls back to the default for nonsense", () => {
    expect(clampFontIndex(-3)).toBe(0);
    expect(clampFontIndex(99)).toBe(FONT_SIZES.length - 1);
    expect(clampFontIndex(3)).toBe(3);
    for (const bad of [NaN, 1.5, Infinity]) expect(clampFontIndex(bad)).toBe(DEFAULT_FONT_INDEX);
    expect(FONT_SIZES[DEFAULT_FONT_INDEX]).toBe(100);
  });
  it("keys a place by profile and book", () => {
    expect(placeKey("v1", "t1")).toBe("roam-read:v1:t1");
    expect(placeKey("v1", "t1")).not.toBe(placeKey("v2", "t1"));
  });
  it("accepts a real-looking CFI and refuses anything else", () => {
    for (const ok of ["epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/3:10)", "epubcfi(/6/14!/4/2/1:0)"]) expect(validCfi(ok), ok).toBe(true);
    for (const bad of ["", "javascript:alert(1)", "epubcfi()", "epubcfi(/6/4)<script>", 5, null, undefined, "epubcfi(" + "1".repeat(3000) + ")"]) expect(validCfi(bad), String(bad)).toBe(false);
  });
});
