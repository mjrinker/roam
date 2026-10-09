import { describe, expect, it } from "vitest";
import { pickInitialTrack, readChoice, rememberedChoice, writeChoice, type TrackChoice } from "./choice";

const t = (id: string, language: string, hearingImpaired = false): TrackChoice => ({ id, language, hearingImpaired });

describe("pickInitialTrack", () => {
  const tracks = [t("a", "en", true), t("b", "en"), t("c", "es"), t("d", "pt-BR")];
  it("turns nothing on without a memory, or when it was off", () => {
    expect(pickInitialTrack(tracks, null)).toBeNull();
    expect(pickInitialTrack(tracks, "off")).toBeNull();
    expect(pickInitialTrack([], "en")).toBeNull();
  });
  it("picks the remembered language, preferring the ordinary version over the hearing-impaired one", () => {
    expect(pickInitialTrack(tracks, "en")?.id).toBe("b");
    expect(pickInitialTrack(tracks, "es")?.id).toBe("c");
    expect(pickInitialTrack(tracks, "EN")?.id).toBe("b");
  });
  it("takes the hearing-impaired one when it is the only one in that language", () => {
    expect(pickInitialTrack([t("a", "en", true)], "en")?.id).toBe("a");
  });
  it("treats a language and its regional version as the same language, and picks nothing for a language the video lacks", () => {
    expect(pickInitialTrack(tracks, "pt")?.id).toBe("d");
    expect(pickInitialTrack([t("x", "pt")], "pt-BR")?.id).toBe("x");
    expect(pickInitialTrack(tracks, "fr")).toBeNull();
  });
});

describe("remembering", () => {
  it("remembers the language, or off", () => {
    expect(rememberedChoice(t("a", "es"))).toBe("es");
    expect(rememberedChoice(null)).toBe("off");
  });
  it("round-trips through storage, and shrugs when storage is missing or throws", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readChoice(storage)).toBeNull();
    writeChoice("es", storage);
    expect(readChoice(storage)).toBe("es");
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readChoice(broken)).toBeNull();
    expect(() => writeChoice("en", broken)).not.toThrow();
    expect(readChoice(undefined)).toBeNull();
  });
});
