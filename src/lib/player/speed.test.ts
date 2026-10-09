import { describe, expect, it } from "vitest";
import { clampSpeed, formatSpeed, isValidSpeed, parseSpeedInput, SPEED_PRESETS } from "./speed";

describe("the speed choices", () => {
  it("run from 0.25x to 3x in steps of 0.25", () => {
    expect(SPEED_PRESETS).toHaveLength(12);
    expect(SPEED_PRESETS[0]).toBe(0.25);
    expect(SPEED_PRESETS.at(-1)).toBe(3);
    for (let i = 1; i < SPEED_PRESETS.length; i++) expect(SPEED_PRESETS[i] - SPEED_PRESETS[i - 1]).toBeCloseTo(0.25, 10);
    expect(SPEED_PRESETS).toContain(1);
  });
});

describe("clampSpeed", () => {
  it("keeps a speed in range and to two places", () => {
    expect(clampSpeed(1.25)).toBe(1.25);
    expect(clampSpeed(10)).toBe(3);
    expect(clampSpeed(0.1)).toBe(0.25);
    expect(clampSpeed(1.333)).toBe(1.33);
    expect(clampSpeed(NaN)).toBe(1);
    expect(clampSpeed(Infinity)).toBe(1);
  });
});

describe("isValidSpeed", () => {
  it("accepts numbers from 0.25 to 3 only", () => {
    for (const ok of [0.25, 1, 1.35, 3]) expect(isValidSpeed(ok), String(ok)).toBe(true);
    for (const bad of [0, 0.24, 3.01, NaN, Infinity, "1", null, undefined]) expect(isValidSpeed(bad), String(bad)).toBe(false);
  });
});

describe("parseSpeedInput", () => {
  it("reads plain numbers, a comma decimal and a trailing x", () => {
    expect(parseSpeedInput("1.35")).toBe(1.35);
    expect(parseSpeedInput("1,35")).toBe(1.35);
    expect(parseSpeedInput(" 1.5x ")).toBe(1.5);
    expect(parseSpeedInput("2")).toBe(2);
    expect(parseSpeedInput(".5")).toBe(0.5);
    expect(parseSpeedInput("3")).toBe(3);
    expect(parseSpeedInput("0.25")).toBe(0.25);
  });
  it("refuses anything outside 0.25 to 3 or that isn't a number", () => {
    for (const bad of ["", " ", "abc", "0", "0.2", "3.01", "4", "-1", "1.2.3", "1e1", "NaN", "Infinity", "1 5", "x"]) expect(parseSpeedInput(bad), bad).toBeNull();
  });
});

describe("formatSpeed", () => {
  it("drops trailing zeros", () => {
    expect([formatSpeed(1), formatSpeed(1.25), formatSpeed(0.25), formatSpeed(1.3), formatSpeed(3)]).toEqual(["1x", "1.25x", "0.25x", "1.3x", "3x"]);
  });
});
