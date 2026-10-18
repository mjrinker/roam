import { describe, expect, it } from "vitest";
import { normalizeLanguage, sameLanguage } from "./audio-languages";
import { mediaLanguageSchema } from "./validation";

describe("language codes", () => {
  it("puts the older bibliographic codes in one spelling and rejects what isn't a code", () => {
    expect(normalizeLanguage("FRE")).toBe("fra");
    expect(normalizeLanguage("ger")).toBe("deu");
    expect(normalizeLanguage("eng")).toBe("eng");
    expect(normalizeLanguage("en")).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
    expect(sameLanguage("fre", "fra")).toBe(true);
    expect(sameLanguage("eng", "spa")).toBe(false);
    expect(sameLanguage(null, null)).toBe(false);
  });
  it("accepts a code or null in a profile and refuses anything else", () => {
    expect(mediaLanguageSchema.parse("SPA")).toBe("spa");
    expect(mediaLanguageSchema.parse(null)).toBeNull();
    expect(mediaLanguageSchema.safeParse("english").success).toBe(false);
  });
});
