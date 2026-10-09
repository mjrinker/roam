import { describe, expect, it } from "vitest";
import { defaultVersionRows, describeVersions, effectiveHeight, groupRowsByVersion, pickVersion } from "./versions";

const row = (versionLabel: string, width: number | null = null, height: number | null = null) => ({ versionLabel, width, height });

describe("describeVersions", () => {
  it("lists versions best first and names them from the picture when it has been probed", () => {
    const v = describeVersions([row("720p", 1280, 720), row("4k", 3840, 2160), row("1080p", 1920, 800)]);
    expect(v.map((x) => [x.label, x.name, x.height])).toEqual([["4k", "4K", 2160], ["1080p", "1080p", 1080], ["720p", "720p", 720]]);
  });
  it("falls back to the label before anything is probed, and calls a file with no label the original", () => {
    const v = describeVersions([row(""), row("1080p"), row("4k")]);
    expect(v.map((x) => [x.label, x.name])).toEqual([["4k", "4K"], ["1080p", "1080p"], ["", "Original"]]);
  });
  it("tells two same-resolution versions apart by the words in their labels", () => {
    const v = describeVersions([row("1080p bluray", 1920, 1080), row("1080p web", 1920, 1080)]);
    expect(v.map((x) => x.name)).toEqual(["1080p (bluray)", "1080p (web)"]);
  });
  it("counts only the first probed part of a version", () => {
    expect(describeVersions([row("4k"), row("4k", 3840, 2160)])[0].name).toBe("4K");
  });
});

describe("pickVersion", () => {
  const versions = describeVersions([row("4k", 3840, 2160), row("1080p", 1920, 1080), row("720p", 1280, 720)]);
  it("takes an explicit request that exists", () => {
    expect(pickVersion(versions, "720p", 2160)).toBe("720p");
  });
  it("ignores a request that doesn't exist", () => {
    expect(pickVersion(versions, "480p", null)).toBe("4k");
  });
  it("takes the highest with no preference", () => {
    expect(pickVersion(versions, null, null)).toBe("4k");
  });
  it("takes the closest to a preferred height, the lower one on a tie", () => {
    expect(pickVersion(versions, null, 1080)).toBe("1080p");
    expect(pickVersion(versions, null, 950)).toBe("1080p"); expect(pickVersion(versions, null, 900)).toBe("720p");
    expect(pickVersion(versions, null, 540)).toBe("720p");
    expect(pickVersion(versions, null, 4000)).toBe("4k");
    expect(pickVersion(describeVersions([row("1080p", 1920, 1080), row("480p", 854, 480)]), null, 780)).toBe("480p"); // 300 vs 300: lower
  });
  it("copes with versions of unknown height and with none at all", () => {
    expect(pickVersion([{ label: "x", name: "x", height: null }], null, 720)).toBe("x");
    expect(pickVersion([], "1080p", null)).toBe("");
  });
});

describe("defaultVersionRows and grouping", () => {
  it("keeps only the best version's rows, parts and all", () => {
    const rows = [row("1080p", 1920, 1080), row("4k", 3840, 2160), row("4k", 3840, 2160)];
    expect(defaultVersionRows(rows)).toHaveLength(2);
    expect(defaultVersionRows([])).toEqual([]);
  });
  it("groups by label", () => {
    expect([...groupRowsByVersion([row("a"), row("b"), row("a")]).keys()]).toEqual(["a", "b"]);
  });
  it("works out a height from width alone", () => {
    expect(effectiveHeight(3840, null)).toBe(2160);
    expect(effectiveHeight(null, null)).toBeNull();
  });
});
