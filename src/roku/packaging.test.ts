import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { configBrs, manifestFor, parseVersion } from "./packaging";

describe("parseVersion", () => {
  it("reads major.minor and major.minor.build", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, build: 3 });
    expect(parseVersion("2.0")).toEqual({ major: 2, minor: 0, build: 0 });
  });
  it("refuses anything else", () => {
    for (const bad of ["", "1", "a.b.c", "1.2.3.4", "1.2.-3", "latest"]) expect(() => parseVersion(bad), bad).toThrow();
  });
});

describe("configBrs", () => {
  it("writes the site's address into a function the channel calls", () => {
    const text = configBrs("https://roam.example");
    expect(text).toContain('return "https://roam.example"');
    expect(text).toContain("function roamBaseUrl() as String");
    expect(text).toContain("function roamUnsupportedAudio() as String");
    expect(text).toContain("function roamMuteAsSkip() as Boolean");
  });
  it("refuses an address with a path or without https, so a broken channel is never written", () => {
    for (const bad of ["https://roam.example/tv", "http://roam.example", 'https://roam.example"x', ""]) expect(() => configBrs(bad), bad).toThrow();
  });
  it("matches the file kept in roku/source for the default site, apart from the address", () => {
    const kept = readFileSync("roku/source/config.brs", "utf8");
    expect(configBrs("https://roam-three-gray.vercel.app")).toBe(kept);
  });
});

describe("manifestFor", () => {
  it("sets the version and keeps everything else", () => {
    const base = readFileSync("roku/manifest", "utf8");
    const out = manifestFor(base, "3.4.5");
    expect(out).toContain("major_version=3");
    expect(out).toContain("minor_version=4");
    expect(out).toContain("build_version=5");
    expect(out).toContain("title=Roam");
    expect(out).toContain("ui_resolutions=hd");
  });
});
