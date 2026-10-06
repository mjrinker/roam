import { describe, expect, it } from "vitest";
import { formatFileSize } from "./format";

describe("formatFileSize", () => {
  it("formats sizes for people", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(3_453_641)).toBe("3.3 MB");
    expect(formatFileSize(1024 ** 3)).toBe("1 GB");
    expect(formatFileSize(150 * 1024 ** 2)).toBe("150 MB");
  });
  it("rolls over to the next unit instead of showing 1024", () => {
    expect(formatFileSize(1048575)).toBe("1.0 MB");
    expect(formatFileSize(1024 ** 3 - 1)).toBe("1.0 GB");
  });
  it("is nothing for an unknown or nonsensical size", () => {
    for (const v of [null, undefined, -1, NaN, Infinity]) expect(formatFileSize(v as never), String(v)).toBeNull();
  });
});
