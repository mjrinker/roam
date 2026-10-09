import { describe, expect, it } from "vitest";
import { newSeed, parseSeed, shuffled } from "./shuffle";

describe("shuffled", () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  it("keeps every item exactly once and does not change the input", () => {
    const out = shuffled(items, 12345);
    expect([...out].sort((a, b) => a - b)).toEqual(items);
    expect(items).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
  it("gives the same order for the same seed and a different one for another", () => {
    expect(shuffled(items, 7)).toEqual(shuffled(items, 7));
    expect(shuffled(items, 7)).not.toEqual(shuffled(items, 8));
    expect(shuffled(items, 7)).not.toEqual(items);
  });
  it("copes with nothing and one item", () => {
    expect(shuffled([], 1)).toEqual([]);
    expect(shuffled(["a"], 1)).toEqual(["a"]);
  });
});

describe("parseSeed / newSeed", () => {
  it("accepts a plain positive number and nothing else", () => {
    expect(parseSeed("42")).toBe(42);
    for (const bad of [null, undefined, "", "0", "-1", "1.5", "abc", "99999999999", "2147483648", "1e5", " 5"]) expect(parseSeed(bad as never), String(bad)).toBeNull();
  });
  it("makes seeds it accepts itself", () => {
    for (let i = 0; i < 50; i++) expect(parseSeed(String(newSeed()))).not.toBeNull();
  });
});
