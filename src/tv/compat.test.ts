/**
 * The TV interface has to run on Chromium 56 (Samsung 2018). esbuild lowers the SYNTAX of the script, but it cannot know about
 * newer browser features, and a stylesheet is never checked at all, so both are scanned here for anything that engine lacks.
 * To allow something new, check it against caniuse for Chrome 56 first.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTvScript } from "./build";

/** Script features added after Chrome 56. */
export const BANNED_SCRIPT = [
  [/\.finally\(/, "Promise.prototype.finally (Chrome 63)"],
  [/Object\.fromEntries/, "Object.fromEntries (73)"],
  [/\.flatMap\(/, "Array.prototype.flatMap (69)"],
  [/\.flat\(/, "Array.prototype.flat (69)"],
  [/\.at\(-?\d/, "Array/String .at() (92)"],
  [/\.replaceAll\(/, "String.replaceAll (85)"],
  [/\.matchAll\(/, "String.matchAll (73)"],
  [/structuredClone/, "structuredClone (98)"],
  [/AbortController/, "AbortController (66)"],
  [/ResizeObserver/, "ResizeObserver (64)"],
  [/Object\.hasOwn\b/, "Object.hasOwn (93)"],
  [/globalThis/, "globalThis (71)"],
  [/queueMicrotask/, "queueMicrotask (71)"],
  [/\.padStart\(|\.padEnd\(/, "padStart/padEnd (57)"],
  [/\.trimStart\(|\.trimEnd\(/, "trimStart/trimEnd (66)"],
  [/BigInt/, "BigInt (67)"],
  [/Intl\.(?:RelativeTimeFormat|ListFormat|PluralRules)/, "newer Intl APIs"],
  [/scrollTo\(\{|scrollBy\(\{|scrollIntoView\(\{/, "options-object scrolling (Chrome 61+)"],
  [/\.replaceChildren\(|\.append\(|\.prepend\(|\.before\(|\.after\(|\.replaceWith\(/, "ChildNode/ParentNode helpers (54-86)"],
  [/\.toSorted\(|\.toReversed\(|\.findLast\(/, "newer array methods"],
] as const;

/** Stylesheet features added after Chrome 56. */
export const BANNED_CSS = [
  [/display\s*:\s*(inline-)?grid|grid-template|grid-area|grid-column|grid-row/, "CSS grid (57)"],
  [/\bgap\s*:|row-gap|column-gap/, "gap (flex 84, grid 66)"],
  [/aspect-ratio/, "aspect-ratio (88)"],
  [/\binset\s*:/, "inset (87)"],
  [/oklch\(|oklab\(|lab\(|lch\(|color-mix\(/, "modern colour functions (111)"],
  [/\b(?:min|max|clamp)\(/, "min()/max()/clamp() (79)"],
  [/:is\(|:where\(|:has\(|:focus-visible|:focus-within/, "newer selectors (60-105)"],
  [/@container|@layer|@property/, "container queries / cascade layers (99-105)"],
  [/\d(?:dvh|svh|lvh|dvw|svw|lvw)\b/, "dynamic viewport units (108)"],
  [/backdrop-filter/, "backdrop-filter (76)"],
  [/scroll-behavior|scroll-snap|overscroll-behavior/, "scroll behaviour (61-69)"],
  [/place-items|place-content|place-self/, "place-* (59)"],
  [/\btranslate\s*:|\brotate\s*:|\bscale\s*:/, "individual transform properties (104)"],
  [/text-wrap|accent-color|text-decoration-thickness/, "newer text properties"],
] as const;

describe("the TV script", () => {
  it("is built for Chromium 56 and uses nothing newer", async () => {
    const code = await buildTvScript(process.cwd());
    expect(code.length).toBeGreaterThan(2000);
    expect(code.length).toBeLessThan(40_000); // a 2018 TV parses this on a slow CPU: keep it small
    for (const [pattern, name] of BANNED_SCRIPT) expect(pattern.test(code), name).toBe(false);
    // syntax newer than Chrome 56 was lowered: no optional chaining, nullish coalescing, class fields or logical assignment left
    expect(code).not.toMatch(/\?\.[a-zA-Z_$[(]/);
    expect(code).not.toMatch(/\?\?[^?]/);
    expect(code).not.toMatch(/\|\|=|&&=|\?\?=/);
  });
  it("catches a banned feature (the scan itself works)", () => {
    expect(BANNED_SCRIPT.some(([p]) => p.test("x.flatMap(y)"))).toBe(true);
    expect(BANNED_CSS.some(([p]) => p.test(".a{display:grid}"))).toBe(true);
    expect(BANNED_CSS.some(([p]) => p.test(".a{width:min(1rem,2rem)}"))).toBe(true);
  });
});

describe("the TV stylesheet", () => {
  // comments may talk about the banned features; only the rules count
  const css = readFileSync(path.join(process.cwd(), "public/tv/tv.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("uses nothing newer than Chromium 56 supports", () => {
    expect(css.length).toBeGreaterThan(1000);
    for (const [pattern, name] of BANNED_CSS) expect(pattern.test(css), name).toBe(false);
  });
});
