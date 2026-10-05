import { describe, expect, it } from "vitest";
import { naturalSortKey } from "./sort-key";

const sorted = (names: string[]) => [...names].sort((a, b) => (naturalSortKey(a) < naturalSortKey(b) ? -1 : naturalSortKey(a) > naturalSortKey(b) ? 1 : 0));

describe("naturalSortKey", () => {
  it("orders numbers by value", () => {
    expect(sorted(["Track 10", "Track 2", "Track 1"])).toEqual(["Track 1", "Track 2", "Track 10"]);
    expect(sorted(["s01e10.mp4", "s01e2.mp4", "s01e1.mp4"])).toEqual(["s01e1.mp4", "s01e2.mp4", "s01e10.mp4"]);
    expect(sorted(["02 - B.mp3", "10 - C.mp3", "01 - A.mp3"])).toEqual(["01 - A.mp3", "02 - B.mp3", "10 - C.mp3"]);
  });
  it("pads the name but never the extension (the 4 in .mp4 is not a track number)", () => {
    expect(naturalSortKey("Track 10.mp4")).toBe("track 000000000010.mp4");
    expect(naturalSortKey("a.m4b")).toBe("a.m4b");
    expect(naturalSortKey("no extension 7")).toBe("no extension 000000000007");
    expect(naturalSortKey("archive.v2.final.mp3")).toBe("archive.v000000000002.final.mp3");
    expect(naturalSortKey(".hidden3")).toBe(".hidden000000000003"); // a leading dot is not an extension
  });
  it("ignores case, and treats equivalent Unicode forms alike", () => {
    expect(naturalSortKey("ZEBRA.mp3")).toBe(naturalSortKey("zebra.mp3"));
    expect(naturalSortKey("Café.mp3")).toBe(naturalSortKey("Café.mp3"));
  });
  it("leaves absurdly long digit runs alone rather than inflating them", () => {
    expect(naturalSortKey("a" + "9".repeat(40))).toBe("a" + "9".repeat(40));
    expect(naturalSortKey("7")).toBe("000000000007");
  });
});
