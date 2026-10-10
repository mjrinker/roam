import { describe, expect, it } from "vitest";
import { EXTRA_CATEGORIES, EXTRA_LABELS, extraCategoryOfFile, extraCategoryOfFolder, extraDisplayName } from "./categories";
import { isExtraFile } from "@/lib/scan/conventions";

describe("Plex extras naming", () => {
  it("reads the type from a file's suffix, every type Plex defines", () => {
    const cases: [string, string | null][] = [
      ["Teaser-trailer.mp4", "trailers"],
      ["Making Of-behindthescenes.mkv", "behindthescenes"],
      ["Cut Scene-deleted.mp4", "deleted"],
      ["The Look-featurette.mov", "featurettes"],
      ["Director Talk-interview.mp4", "interviews"],
      ["Opening-scene.mp4", "scenes"],
      ["Little Film-short.mp4", "shorts"],
      ["Misc-other.mp4", "other"],
      ["TEASER-TRAILER.MP4", "trailers"],
      ["Movie (2020).mp4", null],
      ["Movie (2020) - trailer.mp4", null], // Plex wants the hyphen right against the type
      ["trailer.mp4", null],
    ];
    for (const [name, category] of cases) expect(extraCategoryOfFile(name), name).toBe(category);
  });
  it("agrees with the scanner about what is an extra file", () => {
    for (const name of ["Teaser-trailer.mp4", "Movie.mp4", "A-short.mkv", "x-trailers.mp4"]) expect(extraCategoryOfFile(name) !== null, name).toBe(isExtraFile(name));
  });
  it("reads the type from a subfolder's name, ignoring case and spacing", () => {
    const cases: [string, string | null][] = [
      ["Trailers", "trailers"],
      ["Behind The Scenes", "behindthescenes"],
      ["behind the scenes", "behindthescenes"],
      ["Deleted Scenes", "deleted"],
      ["Featurettes", "featurettes"],
      ["Interviews", "interviews"],
      ["Scenes", "scenes"],
      ["Shorts", "shorts"],
      ["Other", "other"],
      ["Season 01", null],
      ["Subs", null],
    ];
    for (const [name, category] of cases) expect(extraCategoryOfFolder(name), name).toBe(category);
  });
  it("names an extra from its file name without the suffix and extension", () => {
    expect(extraDisplayName("Official Teaser-trailer.mp4")).toBe("Official Teaser");
    expect(extraDisplayName("Making_of the film.mkv")).toBe("Making of the film");
    expect(extraDisplayName("-trailer.mp4")).toBe("-trailer.mp4"); // nothing left: keep the file name
  });
  it("has a heading for every type", () => {
    expect(EXTRA_CATEGORIES.every((c) => EXTRA_LABELS[c])).toBe(true);
  });
});
