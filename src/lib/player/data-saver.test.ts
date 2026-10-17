import { describe, expect, it } from "vitest";
import { aimHeight, DATA_SAVER_HEIGHT, imageQuality } from "./data-saver";
import { describeVersions, pickVersion } from "./versions";

describe("data saver", () => {
  it("aims video at 480p at most, keeps a lower request, and leaves everything alone when off", () => {
    expect(aimHeight(null, true)).toBe(DATA_SAVER_HEIGHT);
    expect(aimHeight(1080, true)).toBe(480);
    expect(aimHeight(2160, true)).toBe(480);
    expect(aimHeight(360, true)).toBe(360);
    expect(aimHeight(null, false)).toBeNull();
    expect(aimHeight(1080, false)).toBe(1080);
  });
  it("asks for smaller pictures when on", () => {
    expect(imageQuality(false)).toBe(75);
    expect(imageQuality(true)).toBe(40);
  });
  it("makes the version picker choose the one nearest 480p (lower on a tie), or the best when off", () => {
    const row = (versionLabel: string, width: number, height: number) => ({ versionLabel, width, height });
    const versions = describeVersions([row("1080p", 1920, 1080), row("720p", 1280, 720), row("360p", 640, 360)]);
    expect(pickVersion(versions, null, aimHeight(null, true))).toBe("360p"); // 480 sits between 360 and 720: 120 from 360, 240 from 720
    expect(pickVersion(versions, null, aimHeight(null, false))).toBe("1080p");
    expect(pickVersion(versions, "1080p", aimHeight(null, true))).toBe("1080p"); // an explicit choice wins
    const withSd = describeVersions([row("1080p", 1920, 1080), row("480p", 854, 480)]);
    expect(pickVersion(withSd, null, aimHeight(1080, true))).toBe("480p");
  });
});
