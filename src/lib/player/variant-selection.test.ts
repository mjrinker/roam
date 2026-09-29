import { describe, expect, it } from "vitest";
import { parseUnsupportedCodecs, shouldUseVariant, type PrimaryForVariant, type VariantCandidate } from "./variant-selection";

const primary = (over: Partial<PrimaryForVariant> = {}): PrimaryForVariant => ({
  audioCodec: "ac-3",
  durationSeconds: 5400,
  durationMs: null,
  trimStartSeconds: null,
  trimDurationSeconds: null,
  ...over,
});
const variant = (over: Partial<VariantCandidate> = {}): VariantCandidate => ({
  boxFileId: "v1",
  durationSeconds: 5400,
  durationMs: null,
  ...over,
});

describe("shouldUseVariant", () => {
  it("uses the copy when the browser can't decode the original's codec", () => {
    expect(shouldUseVariant(primary(), variant(), ["ac-3"])).toBe(true);
  });

  it("keeps the original when the browser CAN decode its codec (e.g. Safari + AC-3)", () => {
    expect(shouldUseVariant(primary(), variant(), ["dtsc"])).toBe(false);
    expect(shouldUseVariant(primary(), variant(), [])).toBe(false);
  });

  it("keeps the original when its codec is unknown", () => {
    expect(shouldUseVariant(primary({ audioCodec: null }), variant(), ["ac-3"])).toBe(false);
  });

  it("rejects a copy whose duration is unprobed or drifts more than ~2s", () => {
    expect(shouldUseVariant(primary(), variant({ durationSeconds: null }), ["ac-3"])).toBe(false);
    expect(shouldUseVariant(primary(), variant({ durationSeconds: 5401.5 }), ["ac-3"])).toBe(true);
    expect(shouldUseVariant(primary(), variant({ durationSeconds: 5410 }), ["ac-3"])).toBe(false);
    expect(shouldUseVariant(primary({ durationSeconds: null }), variant(), ["ac-3"])).toBe(false);
  });

  it("prefers millisecond durations when present", () => {
    expect(shouldUseVariant(primary({ durationMs: 5_400_000 }), variant({ durationMs: 5_401_000 }), ["ac-3"])).toBe(true);
  });

  it("requires the primary's trim window to fit inside the copy", () => {
    const trimmed = primary({ trimStartSeconds: 1800, trimDurationSeconds: 1800 });
    expect(shouldUseVariant(trimmed, variant(), ["ac-3"])).toBe(true);
    expect(shouldUseVariant(primary({ trimStartSeconds: 4000, trimDurationSeconds: 1800 }), variant(), ["ac-3"])).toBe(false);
  });
});

describe("parseUnsupportedCodecs", () => {
  it("parses, lowercases and dedupes", () => {
    expect(parseUnsupportedCodecs("ac-3,EC-3,ac-3")).toEqual(["ac-3", "ec-3"]);
  });
  it("drops junk and handles absence", () => {
    expect(parseUnsupportedCodecs(null)).toEqual([]);
    expect(parseUnsupportedCodecs("")).toEqual([]);
    expect(parseUnsupportedCodecs("ac-3,;drop table,x")).toEqual(["ac-3"]);
  });
});
