import { describe, expect, it } from "vitest";
import { evaluateScreenTime, hasScreenTimeRules, inQuietHours, localClock, stopInSeconds, type ScreenTimeSettings } from "./rules";

const settings = (over: Partial<ScreenTimeSettings> = {}): ScreenTimeSettings => ({ limitMinutes: null, quietFrom: null, quietTo: null, timeZone: "America/Denver", ...over });
// 02:30 UTC on the 18th is 20:30 on the 17th in Denver (MDT, UTC-6).
const evening = new Date("2026-10-18T02:30:00Z");

describe("the local clock", () => {
  it("is the day and time in the profile's own zone", () => {
    expect(localClock(evening, "America/Denver")).toEqual({ day: "2026-10-17", minutes: 20 * 60 + 30, seconds: 0 });
    expect(localClock(evening, "UTC").day).toBe("2026-10-18");
    expect(localClock(evening, "Not/AZone").day).toBe("2026-10-18"); // an unknown zone is UTC
    expect(localClock(evening, null).minutes).toBe(150);
  });
});

describe("quiet hours", () => {
  it("handles a window inside a day and one that runs past midnight", () => {
    expect(inQuietHours(13 * 60, 12 * 60, 14 * 60)).toBe(true);
    expect(inQuietHours(14 * 60, 12 * 60, 14 * 60)).toBe(false);
    expect(inQuietHours(22 * 60, 21 * 60, 7 * 60)).toBe(true);
    expect(inQuietHours(3 * 60, 21 * 60, 7 * 60)).toBe(true);
    expect(inQuietHours(12 * 60, 21 * 60, 7 * 60)).toBe(false);
    expect(inQuietHours(100, null, 500)).toBe(false);
    expect(inQuietHours(100, 300, 300)).toBe(false);
  });
});

describe("may it watch now", () => {
  it("has no rules unless something is set", () => {
    expect(hasScreenTimeRules(settings())).toBe(false);
    expect(hasScreenTimeRules(settings({ limitMinutes: 60 }))).toBe(true);
    expect(hasScreenTimeRules(settings({ quietFrom: 1200, quietTo: null }))).toBe(false);
  });
  it("refuses once the day's limit is used, and says what is left before then", () => {
    const s = settings({ limitMinutes: 60 });
    expect(evaluateScreenTime(s, 3599, evening)).toMatchObject({ allowed: true, remainingSeconds: 1 });
    expect(evaluateScreenTime(s, 3600, evening)).toEqual({ allowed: false, reason: "limit", message: "Screen time is up for today." });
    expect(evaluateScreenTime(settings(), 99999, evening)).toMatchObject({ allowed: true, remainingSeconds: null, untilQuietSeconds: null });
  });
  it("refuses in quiet hours, saying when they end, and counts down to them", () => {
    const night = settings({ quietFrom: 21 * 60, quietTo: 7 * 60 + 30 });
    expect(evaluateScreenTime(night, 0, evening)).toMatchObject({ allowed: true, untilQuietSeconds: 30 * 60 });
    const late = new Date("2026-10-18T03:30:00Z"); // 21:30 in Denver
    expect(evaluateScreenTime(night, 0, late)).toEqual({ allowed: false, reason: "quiet", message: "It's quiet time until 7:30 AM." });
  });
  it("stops at the sooner of the limit and quiet time", () => {
    const d = evaluateScreenTime(settings({ limitMinutes: 120, quietFrom: 21 * 60, quietTo: 7 * 60 }), 0, evening);
    expect(d.allowed && stopInSeconds(d)).toBe(30 * 60);
    const d2 = evaluateScreenTime(settings({ limitMinutes: 10 }), 0, evening);
    expect(d2.allowed && stopInSeconds(d2)).toBe(600);
    const d3 = evaluateScreenTime(settings(), 0, evening);
    expect(d3.allowed && stopInSeconds(d3)).toBeNull();
  });
});
