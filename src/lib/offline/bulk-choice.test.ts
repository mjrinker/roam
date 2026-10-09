import { describe, expect, it } from "vitest";
import { pickOption, qualityChoices, summarizeBulk } from "./bulk-choice";
import type { DownloadOption, DownloadOptions } from "./options";

const opt = (name: string, height: number | null, sizeBytes: number | null): DownloadOption => ({ label: name.toLowerCase(), name, height, sizeBytes, parts: 1 });
const item = (options: DownloadOption[], kind: "watch" | "listen" = "watch"): DownloadOptions => ({ kind, ownerKind: "title", ownerId: "x", title: "t", subtitle: null, posterUrl: null, options });
const ladder = [opt("4K", 2160, 4000), opt("1080p", 1080, 1500), opt("720p", 720, 600), opt("480p", 480, 250)];

describe("pickOption", () => {
  it("takes the best, the smallest picture, or the closest height (the lower on a tie)", () => {
    expect(pickOption(ladder, { kind: "best" })?.name).toBe("4K");
    expect(pickOption(ladder, { kind: "smallest" })?.name).toBe("480p");
    expect(pickOption(ladder, { kind: "height", height: 1080 })?.name).toBe("1080p");
    expect(pickOption(ladder, { kind: "height", height: 900 })?.name).toBe("720p"); // 1080 and 720 are equally far: the lower
    expect(pickOption(ladder, { kind: "height", height: 100 })?.name).toBe("480p");
    expect(pickOption(ladder, { kind: "height", height: 5000 })?.name).toBe("4K");
  });
  it("uses the only choice for audio and for versions of unknown size, and none for nothing", () => {
    const audio = [opt("Audio", null, 50)];
    expect(pickOption(audio, { kind: "smallest" })?.name).toBe("Audio");
    expect(pickOption(audio, { kind: "height", height: 720 })?.name).toBe("Audio");
    expect(pickOption([], { kind: "best" })).toBeNull();
  });
});

describe("qualityChoices", () => {
  it("lists each resolution on offer once, highest first", () => {
    const items = [item([opt("720p", 720, 1), opt("480p", 480, 1)]), item([opt("1080p", 1080, 1), opt("720p", 720, 1)]), item([opt("Audio", null, 1)], "listen")];
    expect(qualityChoices(items)).toEqual([{ height: 1080, name: "1080p" }, { height: 720, name: "720p" }, { height: 480, name: "480p" }]);
  });
  it("strips the extra words a version may carry", () => {
    expect(qualityChoices([item([opt("1080p (bluray)", 1080, 1)])])).toEqual([{ height: 1080, name: "1080p" }]);
  });
});

describe("summarizeBulk", () => {
  it("adds up the chosen version of each item, counting items whose size is unknown", () => {
    const items = [item(ladder), item([opt("720p", 720, 700), opt("480p", 480, null)]), item([opt("Audio", null, 50)], "listen")];
    expect(summarizeBulk(items, { kind: "best" })).toEqual({ count: 3, totalBytes: 4000 + 700 + 50, unknownSizes: 0 });
    expect(summarizeBulk(items, { kind: "smallest" })).toEqual({ count: 3, totalBytes: 250 + 50, unknownSizes: 1 });
    expect(summarizeBulk([], { kind: "best" })).toEqual({ count: 0, totalBytes: 0, unknownSizes: 0 });
  });
});
