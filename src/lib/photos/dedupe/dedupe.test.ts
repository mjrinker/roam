import { describe, expect, it } from "vitest";
import { dHash, distance, groupAlike, isHash, suggestKeep } from "./hash";

/** A 9x8 miniature from a function of (x, y). */
const mini = (f: (x: number, y: number) => number) => Array.from({ length: 72 }, (_, i) => f(i % 9, Math.floor(i / 9)));

describe("the difference hash", () => {
  it("is 16 hex digits, the same for the same picture, and says which pixels are darker than their right neighbour", () => {
    const rising = dHash(mini((x) => x * 10)); // every pixel is darker than the next: all 64 bits set
    expect(rising).toBe("ffffffffffffffff");
    expect(dHash(mini((x) => 100 - x * 10))).toBe("0000000000000000");
    const h = dHash(mini((x, y) => (x * 37 + y * 11) % 90));
    expect(isHash(h)).toBe(true);
    expect(dHash(mini((x, y) => (x * 37 + y * 11) % 90))).toBe(h);
    expect(() => dHash([1, 2, 3])).toThrow();
  });
  it("does not change when the picture is brighter or has more contrast, since only the order of neighbours matters", () => {
    const base = mini((x, y) => (x * 37 + y * 11) % 90);
    expect(dHash(base.map((v) => v * 2 + 20))).toBe(dHash(base));
  });
  it("counts the bits that differ", () => {
    expect(distance("0000000000000000", "0000000000000000")).toBe(0);
    expect(distance("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(distance("00000000000000ff", "0000000000000000")).toBe(8);
    expect(distance("8000000000000001", "0000000000000000")).toBe(2);
    expect(distance("f0f0f0f0f0f0f0f0", "0f0f0f0f0f0f0f0f")).toBe(64);
  });
  it("only accepts a well-formed hash", () => {
    for (const bad of ["", "xyz", "FFFFFFFFFFFFFFFF", "ffffffffffffffff0", null, 5]) expect(isHash(bad)).toBe(false);
  });
});

describe("grouping alike pictures", () => {
  const flip = (hash: string, bits: number[]) => {
    const b = BigInt(`0x${hash}`);
    return bits.reduce((n, bit) => n ^ (BigInt(1) << BigInt(bit)), b).toString(16).padStart(16, "0");
  };
  const base = "0123456789abcdef";
  it("groups pictures within the distance, chains them, and leaves loners out", () => {
    const items = [
      { id: "a", hash: base },
      { id: "b", hash: flip(base, [1, 20]) }, // 2 away
      { id: "c", hash: flip(base, [1, 20, 40, 50]) }, // 2 from b, 4 from a
      { id: "d", hash: "ffffffff00000000" },
      { id: "e", hash: flip("ffffffff00000000", [3]) },
      { id: "z", hash: "a5a5a5a5a5a5a5a5" },
    ];
    const groups = groupAlike(items, 3).map((g) => g.map((i) => i.id).sort());
    expect(groups).toEqual([["a", "b", "c"], ["d", "e"]]);
    expect(groupAlike(items, 1).map((g) => g.map((i) => i.id).sort())).toEqual([["d", "e"]]);
    expect(groupAlike(items, 0)).toEqual([]);
    expect(groupAlike([], 6)).toEqual([]);
  });
  it("finds every pair within the distance wherever the differing bits fall (no pair is missed by the shortcut)", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 40; round++) {
      const a = Array.from({ length: 16 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
      const k = Math.floor(rand() * 9);
      const bits = Array.from(new Set(Array.from({ length: k }, () => Math.floor(rand() * 64))));
      const b = flip(a, bits);
      const found = groupAlike([{ id: "a", hash: a }, { id: "b", hash: b }], 8);
      expect(found.length === 1, `distance ${distance(a, b)}`).toBe(distance(a, b) <= 8);
    }
  });
  it("makes the biggest group first", () => {
    const items = [{ id: "x1", hash: "00000000000000f0" }, { id: "x2", hash: "00000000000000f1" }, { id: "y1", hash: base }, { id: "y2", hash: base }, { id: "y3", hash: base }];
    expect(groupAlike(items, 2).map((g) => g.length)).toEqual([3, 2]);
  });
});

describe("which copy to keep", () => {
  const c = (id: string, over: Partial<{ sizeBytes: number | null; width: number | null; height: number | null; takenAt: Date | null; name: string }>) => ({ id, sizeBytes: 1000, width: 1000, height: 800, takenAt: new Date("2020-01-01"), name: id, ...over });
  it("prefers the most pixels, then the biggest file, the earliest, the shortest name", () => {
    expect(suggestKeep([c("small", { width: 500, height: 400, sizeBytes: 9999 }), c("big", {})]).id).toBe("big");
    expect(suggestKeep([c("a", { sizeBytes: 500 }), c("b", { sizeBytes: 900 })]).id).toBe("b");
    expect(suggestKeep([c("late", { takenAt: new Date("2021-01-01") }), c("early", {})]).id).toBe("early");
    expect(suggestKeep([c("longer-name", {}), c("short", {})]).id).toBe("short");
    expect(suggestKeep([c("a", { width: null, height: null }), c("b", { width: 10, height: 10 })]).id).toBe("b");
  });
});
