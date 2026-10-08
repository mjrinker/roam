import { describe, expect, it } from "vitest";
import { BOOK_CSP, DEFAULT_FONT_INDEX, FONT_SIZES, MAX_READER_BYTES, clampFontIndex, keyBelongsToControl, placeKey, validCfi, withBookCsp } from "./reader";

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

  it("lets a book load nothing from the internet", () => {
    expect(BOOK_CSP).toContain("default-src 'none'");
    expect(BOOK_CSP).not.toMatch(/https?:|\*/);
    expect(BOOK_CSP).not.toContain("script-src");
  });
  it("keeps books small enough for a phone", () => {
    expect(MAX_READER_BYTES).toBeLessThanOrEqual(60 * 1024 * 1024);
  });
  it("leaves the arrow keys alone when a menu, field or button has focus", () => {
    for (const tagName of ["SELECT", "input", "TEXTAREA", "BUTTON", "a"]) expect(keyBelongsToControl({ tagName }), tagName).toBe(true);
    expect(keyBelongsToControl({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(keyBelongsToControl({ tagName: "BODY" })).toBe(false);
    expect(keyBelongsToControl(null)).toBe(false);
  });

  it("puts the policy first in a page's head, whatever the page looks like", () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${BOOK_CSP}"/>`;
    expect(withBookCsp('<html xmlns="x"><head><title>t</title></head><body/></html>')).toBe(`<html xmlns="x"><head>${meta}<title>t</title></head><body/></html>`);
    expect(withBookCsp('<HTML><HEAD profile="p"><link href="remote.css"/></HEAD></HTML>')).toContain(`<HEAD profile="p">${meta}<link`);
    expect(withBookCsp("<html><body>x</body></html>")).toBe(`<html><head>${meta}</head><body>x</body></html>`);
    expect(withBookCsp("<p>fragment</p>")).toBe(`<head>${meta}</head><p>fragment</p>`);
    // a body that merely mentions "<head" later does not move it
    expect(withBookCsp("<html><body><headline/></body></html>")).toContain(`<html><head>${meta}</head>`);
  });
});
