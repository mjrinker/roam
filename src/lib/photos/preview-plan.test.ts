import { describe, expect, it } from "vitest";
import { ORIGINAL_DIRECT_MAX_BYTES, ORIGINAL_FALLBACK_MAX_BYTES, planPreview } from "./preview-plan";

describe("planPreview", () => {
  it("serves a small browser-native picture as it is, a medium one only as a fallback, a big one never", () => {
    for (const type of ["jpg", "JPEG", "png", "webp"]) {
      expect(planPreview(type, ORIGINAL_DIRECT_MAX_BYTES), type).toEqual({ direct: true, originalFallback: true });
      expect(planPreview(type, ORIGINAL_DIRECT_MAX_BYTES + 1), type).toEqual({ direct: false, originalFallback: true });
      expect(planPreview(type, ORIGINAL_FALLBACK_MAX_BYTES), type).toEqual({ direct: false, originalFallback: true });
      expect(planPreview(type, ORIGINAL_FALLBACK_MAX_BYTES + 1), type).toEqual({ direct: false, originalFallback: false });
    }
  });
  it("serves a GIF whole (to keep it animated) up to the fallback size", () => {
    expect(planPreview("gif", ORIGINAL_FALLBACK_MAX_BYTES)).toEqual({ direct: true, originalFallback: true });
    expect(planPreview("gif", ORIGINAL_FALLBACK_MAX_BYTES + 1)).toEqual({ direct: false, originalFallback: false });
  });
  it("never offers the original of a format browsers can't show (HEIC, HEIF, unknown), whatever its size", () => {
    for (const type of ["heic", "heif", "tiff", "", null]) expect(planPreview(type, 100), String(type)).toEqual({ direct: false, originalFallback: false });
  });
  it("treats an unknown size as too big to serve as the original", () => {
    expect(planPreview("jpg", null)).toEqual({ direct: false, originalFallback: false });
  });
});
