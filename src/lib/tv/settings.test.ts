import { describe, expect, it, vi } from "vitest";
import { cycleCategory, nextSeverity, severityWords, signUnlock, toggleAutoSkip, unlockValid, canChangeOwnSettings } from "./settings";

describe("the strength of a category", () => {
  it("goes off, mild, moderate, strong and round to off", () => {
    expect(nextSeverity(undefined)).toBe("low");
    expect(nextSeverity("low")).toBe("medium");
    expect(nextSeverity("medium")).toBe("high");
    expect(nextSeverity("high")).toBeUndefined();
  });
  it("is said in plain words", () => {
    expect([undefined, "low", "medium", "high"].map((s) => severityWords(s as never))).toEqual(["Off", "Mild and up", "Moderate and up", "Strong only"]);
  });
  it("changes one category and leaves the others, and removes it when it comes round to off", () => {
    expect(cycleCategory({ violence: "high", language: "low" }, "violence")).toEqual({ language: "low" });
    expect(cycleCategory({ language: "low" }, "violence")).toEqual({ language: "low", violence: "low" });
    expect(cycleCategory({}, "not-a-category")).toBeNull();
    expect(cycleCategory({}, 5)).toBeNull();
  });
});

describe("skipping automatically", () => {
  it("switches one kind on and off", () => {
    expect(toggleAutoSkip({}, "intro")).toEqual({ intro: true });
    expect(toggleAutoSkip({ intro: true, outro: true }, "intro")).toEqual({ outro: true });
    expect(toggleAutoSkip({}, "bogus")).toBeNull();
  });
});

describe("who may change settings", () => {
  it("is the owner and an admin profile, not a child's", () => {
    expect(canChangeOwnSettings({ id: "a", role: "owner" })).toBe(true);
    expect(canChangeOwnSettings({ id: "a", role: "admin" })).toBe(true);
    expect(canChangeOwnSettings({ id: "a", role: "limited" })).toBe(false);
  });
});

describe("the PIN pass for the settings page", () => {
  const key = Buffer.alloc(32, 9).toString("base64");
  it("works for that profile for ten minutes only", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", key);
    const now = 1_000_000;
    const cookie = signUnlock("viewer-1", 3, now);
    expect(unlockValid(cookie, "viewer-1", 3, now + 60_000)).toBe(true);
    expect(unlockValid(cookie, "viewer-1", 3, now + 11 * 60_000)).toBe(false);
    vi.unstubAllEnvs();
  });
  it("is no use for another profile, after the PIN changed, tampered with, or missing", () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", key);
    const now = 1_000_000;
    const cookie = signUnlock("viewer-1", 3, now);
    expect(unlockValid(cookie, "viewer-2", 3, now)).toBe(false);
    expect(unlockValid(cookie, "viewer-1", 4, now)).toBe(false);
    expect(unlockValid(cookie.replace("viewer-1", "viewer-2"), "viewer-2", 3, now)).toBe(false);
    expect(unlockValid(cookie.slice(0, -2) + "xx", "viewer-1", 3, now)).toBe(false);
    expect(unlockValid(undefined, "viewer-1", 3, now)).toBe(false);
    expect(unlockValid("garbage", "viewer-1", 3, now)).toBe(false);
    vi.unstubAllEnvs();
  });
});
