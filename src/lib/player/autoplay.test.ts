import { describe, expect, it } from "vitest";
import { readAutoplay, writeAutoplay } from "./autoplay";

describe("autoplay of the next episode", () => {
  it("is on until turned off on this device, and survives blocked storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readAutoplay(storage)).toBe(true);
    writeAutoplay(false, storage);
    expect(readAutoplay(storage)).toBe(false);
    writeAutoplay(true, storage);
    expect(readAutoplay(storage)).toBe(true);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readAutoplay(broken)).toBe(true);
    expect(() => writeAutoplay(false, broken)).not.toThrow();
    expect(readAutoplay(undefined)).toBe(true);
  });
});
