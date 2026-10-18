import { describe, expect, it } from "vitest";
import { automaticHeight } from "./automatic-quality";
import { readPreferredHeight, readQualityMode, writePreferredHeight, writeQualityMode } from "./quality-preference";

const phonePortrait = { viewportWidth: 360, viewportHeight: 640, pixelRatio: 3 };
const phoneLandscape = { viewportWidth: 812, viewportHeight: 375, pixelRatio: 3 };
const desktop = { viewportWidth: 1920, viewportHeight: 1080, pixelRatio: 1 };
const tv4k = { viewportWidth: 1920, viewportHeight: 1080, pixelRatio: 2 };

describe("automatic quality", () => {
  it("asks for what the screen can show: a phone held upright needs less than the same phone on its side", () => {
    expect(automaticHeight(phonePortrait)).toBe(720); // the picture is 202 css px tall: about 607 lines at 3x
    expect(automaticHeight(phoneLandscape)).toBe(1080);
    expect(automaticHeight(desktop)).toBe(1080);
    expect(automaticHeight(tv4k)).toBe(2160);
  });
  it("is lowered by a slow connection or data saver, never raised", () => {
    expect(automaticHeight({ ...desktop, downlinkMbps: 1 })).toBe(360);
    expect(automaticHeight({ ...desktop, downlinkMbps: 2.5 })).toBe(480);
    expect(automaticHeight({ ...desktop, downlinkMbps: 5 })).toBe(720);
    expect(automaticHeight({ ...desktop, downlinkMbps: 50 })).toBe(1080);
    expect(automaticHeight({ ...desktop, effectiveType: "3g" })).toBe(480);
    expect(automaticHeight({ ...desktop, effectiveType: "2g" })).toBe(240);
    expect(automaticHeight({ ...desktop, dataSaver: true })).toBe(480);
    expect(automaticHeight({ ...phonePortrait, dataSaver: true })).toBeLessThanOrEqual(480);
    expect(automaticHeight({ ...phoneLandscape, viewportWidth: 200, viewportHeight: 100, pixelRatio: 1 })).toBe(144);
  });
});

describe("the remembered quality", () => {
  const make = () => {
    const store = new Map<string, string>();
    return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  };
  it("is a pick until Automatic or Original is chosen, and a later pick ends either", () => {
    const s = make();
    expect(readQualityMode(s)).toBe("pick");
    writeQualityMode("original", s);
    expect(readQualityMode(s)).toBe("original");
    writeQualityMode("auto", s);
    expect(readQualityMode(s)).toBe("auto");
    writePreferredHeight(720, s);
    expect(readQualityMode(s)).toBe("pick");
    expect(readPreferredHeight(s)).toBe(720);
  });
  it("keeps the last pick while a mode is on, so nothing is lost, and shrugs at blocked storage", () => {
    const s = make();
    writePreferredHeight(480, s);
    writeQualityMode("auto", s);
    expect(readPreferredHeight(s)).toBe(480);
    const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } };
    expect(readQualityMode(broken)).toBe("pick");
    expect(() => writeQualityMode("auto", broken)).not.toThrow();
  });
});
