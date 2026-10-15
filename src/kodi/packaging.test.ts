import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ADDON_ID, addonXmlFor, settingsXmlFor, validVersion } from "./packaging";

const addon = readFileSync("kodi/plugin.video.roam/addon.xml", "utf8");
const settings = readFileSync("kodi/plugin.video.roam/resources/settings.xml", "utf8");

describe("addon.xml", () => {
  it("names the add-on the code and the packaging expect", () => {
    expect(addon).toContain(`id="${ADDON_ID}"`);
    expect(addon).toContain('library="main.py"');
    expect(addon).toContain('<import addon="xbmc.python" version="3.0.0"/>');
  });
  it("takes a version, and refuses nonsense", () => {
    expect(addonXmlFor(addon, "2.3.4")).toContain('version="2.3.4"');
    expect(addonXmlFor(addon, "2.3.4")).toContain('<import addon="xbmc.python" version="3.0.0"/>'); // the dependency's version is left alone
    for (const bad of ["", "1", "1.0", "x.y.z", "1.0.0.0"]) expect(validVersion(bad), bad).toBe(false);
    expect(() => addonXmlFor(addon, "latest")).toThrow();
  });
});

describe("settings.xml", () => {
  it("starts people on the site's address", () => {
    const out = settingsXmlFor(settings, "https://roam.example");
    expect(out).toContain("<default>https://roam.example</default>");
    expect(out).not.toContain("{{SERVER}}");
  });
  it("refuses an address that isn't a plain https site", () => {
    for (const bad of ["https://roam.example/tv", "http://roam.example", "", "javascript:1"]) expect(() => settingsXmlFor(settings, bad), bad).toThrow();
  });
});

describe("the add-on's own tests", () => {
  const python = spawnSync("python3", ["--version"]);
  it.skipIf(python.status !== 0)("pass (Python unit tests with stand-ins for Kodi)", () => {
    const run = spawnSync("python3", ["-m", "unittest", "discover", "-p", "test_*.py"], { cwd: "kodi/tests", encoding: "utf8" });
    expect(run.stderr + run.stdout).toMatch(/OK/);
    expect(run.status).toBe(0);
  }, 60_000);
});
