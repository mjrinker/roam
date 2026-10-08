import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, CODE_LENGTH, normalizeUserCode, typedLength } from "./code";

describe("the short code rules the phone form and the server share", () => {
  it("is five characters, so typing it on a remote is quick", () => {
    expect(CODE_LENGTH).toBe(5);
    expect(CODE_ALPHABET).toHaveLength(31);
    expect(31 ** CODE_LENGTH).toBeGreaterThan(28_000_000);
  });
  it("ignores case, spaces and hyphens", () => {
    expect(normalizeUserCode("k7mq2")).toBe("K7MQ2");
    expect(normalizeUserCode("K7 mQ-2")).toBe("K7MQ2");
  });
  it("counts only the characters that matter while someone types", () => {
    expect(typedLength("k7 m-q")).toBe(4);
    expect(typedLength("")).toBe(0);
  });
});
