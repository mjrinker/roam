import { describe, expect, it } from "vitest";
import { findAll, parseXml } from "@/lib/ebooks/xml";
import { canonicalOrigin, tvHost } from "@/lib/tv/origin";
import { TIZEN_APP_ID, TIZEN_PACKAGE_ID, siteOrigin, tizenConfig, validVersion, webosAppInfo, webosIndexHtml } from "./packaging";

describe("siteOrigin", () => {
  it("keeps the origin of an https address and drops any path", () => {
    expect(siteOrigin("https://roam-three-gray.vercel.app/some/path?x=1")).toBe("https://roam-three-gray.vercel.app");
    expect(siteOrigin(" https://roam.example:8443 ")).toBe("https://roam.example:8443");
    expect(siteOrigin("http://localhost:3000/tv")).toBe("http://localhost:3000");
  });
  it("refuses anything that isn't a plain https site", () => {
    for (const bad of ["", null, undefined, "roam.example", "http://roam.example", "ftp://roam.example", "https://user:pw@roam.example", "javascript:alert(1)", "https://", "https://ro am.example", "https://roam.example\"><x"]) {
      expect(siteOrigin(bad as never), String(bad)).toBeNull();
    }
  });
});

describe("Tizen config", () => {
  it("is well-formed, opens the site's /tv, and asks only for the remote's keys and the network", () => {
    const xml = tizenConfig("https://roam.example", "1.2.3");
    const doc = parseXml(xml);
    expect(findAll(doc, "content")[0].attrs.src).toBe("https://roam.example/tv");
    expect(findAll(doc, "widget")[0].attrs.version).toBe("1.2.3");
    const app = findAll(doc, "application")[0].attrs;
    expect([app.id, app.package, app.required_version]).toEqual([TIZEN_APP_ID, TIZEN_PACKAGE_ID, "4.0"]);
    expect(TIZEN_PACKAGE_ID).toHaveLength(10);
    expect(findAll(doc, "privilege").map((p) => p.attrs.name).sort()).toEqual(["http://tizen.org/privilege/internet", "http://tizen.org/privilege/tv.inputdevice"]);
    expect(findAll(doc, "profile")[0].attrs.name).toBe("tv-samsung");
  });
  it("refuses an origin with a path or a bad version rather than writing a broken file", () => {
    expect(() => tizenConfig("https://roam.example/tv", "1.0.0")).toThrow();
    expect(() => tizenConfig("https://roam.example", "latest")).toThrow();
    expect(() => tizenConfig("http://roam.example", "1.0.0")).toThrow();
  });
});

describe("webOS files", () => {
  it("describes a web app whose main page is local", () => {
    const info = JSON.parse(webosAppInfo("2.0.1"));
    expect(info).toMatchObject({ id: "com.roam.tv", version: "2.0.1", type: "web", main: "index.html", title: "Roam" });
    expect(() => webosAppInfo("1")).toThrow();
  });
  it("hands over to the site's /tv, and the address can't break out of the script", () => {
    const page = webosIndexHtml("https://roam.example");
    expect(page).toContain('"https://roam.example/tv"');
    expect(page).toContain("can't be reached");
    expect(() => webosIndexHtml("https://roam.example/path")).toThrow();
    expect(() => webosIndexHtml("javascript:alert(1)")).toThrow();
  });
  it("accepts only dotted version numbers", () => {
    for (const ok of ["1.0", "1.0.0", "12.34.56"]) expect(validVersion(ok)).toBe(true);
    for (const bad of ["", "1", "1.0.0.0", "v1.0", "1.0-beta", "1..0"]) expect(validVersion(bad), bad).toBe(false);
  });
});

describe("canonicalOrigin / tvHost", () => {
  it("prefers the configured main site over the address a request came in on, and falls back to the request", () => {
    expect(canonicalOrigin("https://short.example/tv/pair", "https://main.example")).toBe("https://main.example");
    expect(canonicalOrigin("https://short.example/tv/pair", "https://main.example/some/path")).toBe("https://main.example");
    for (const bad of [undefined, "", "javascript:alert(1)", "http://insecure.example", "main.example"]) expect(canonicalOrigin("https://short.example/x", bad), String(bad)).toBe("https://short.example");
  });
  it("accepts only a plain hostname as the TV's short address", () => {
    expect(tvHost("RoamTV.vercel.app")).toBe("roamtv.vercel.app");
    for (const bad of [undefined, "", "localhost", "a b.example", "https://x.example", "x.example/path", "x.example:8080", "-x.example", "<x>.example"]) expect(tvHost(bad), String(bad)).toBeNull();
  });
});
