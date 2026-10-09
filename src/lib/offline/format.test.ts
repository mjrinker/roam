import { describe, expect, it } from "vitest";
import { formatBytes, percentOf } from "./format";

describe("formatBytes", () => {
  it("uses the largest unit that keeps the number small, with a decimal only for gigabytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1500)).toBe("2 KB");
    expect(formatBytes(640_000_000)).toBe("640 MB");
    expect(formatBytes(3_200_000_000)).toBe("3.2 GB");
    expect(formatBytes(123_000_000_000)).toBe("123 GB");
    expect(formatBytes(2_500_000_000_000)).toBe("2.5 TB");
  });
  it("says so when the size isn't known", () => {
    expect(formatBytes(null)).toBe("size unknown");
    expect(formatBytes(-1)).toBe("size unknown");
    expect(formatBytes(NaN)).toBe("size unknown");
  });
});

describe("percentOf", () => {
  it("is a whole percent, 100 only when it is done, and null without a total", () => {
    expect(percentOf(42, 100)).toBe(42);
    expect(percentOf(999, 1000)).toBe(99);
    expect(percentOf(1000, 1000)).toBe(100);
    expect(percentOf(5, null)).toBeNull();
    expect(percentOf(5, 0)).toBeNull();
  });
});
