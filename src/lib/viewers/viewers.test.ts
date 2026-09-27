import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
});

import { AVATARS, DEFAULT_AVATAR_KEY, getAvatar, isAvatarKey } from "./avatars";
import { hashPin, isValidPinFormat, verifyPin } from "./pin";
import { signViewerCookie, verifyViewerCookie, viewerIdFromCookie } from "./cookie";
import { DEFAULT_LOCALE, isSupportedLocale, LOCALES } from "./locales";

describe("avatars", () => {
  it("has 24 presets with unique keys, including the default", () => {
    expect(AVATARS).toHaveLength(24);
    expect(new Set(AVATARS.map((a) => a.key)).size).toBe(24);
    expect(isAvatarKey(DEFAULT_AVATAR_KEY)).toBe(true);
  });

  it("falls back to the default for unknown or missing keys", () => {
    expect(getAvatar("nope").key).toBe(DEFAULT_AVATAR_KEY);
    expect(getAvatar(null).key).toBe(DEFAULT_AVATAR_KEY);
    expect(getAvatar("rose-cat").key).toBe("rose-cat");
  });
});

describe("locales", () => {
  it("knows its own tags and rejects others", () => {
    expect(isSupportedLocale(DEFAULT_LOCALE)).toBe(true);
    expect(isSupportedLocale("xx-YY")).toBe(false);
    expect(new Set(LOCALES.map((l) => l.tag)).size).toBe(LOCALES.length);
  });
});

describe("PIN hashing", () => {
  it("accepts only four digits", () => {
    expect(isValidPinFormat("0420")).toBe(true);
    for (const bad of ["123", "12345", "12a4", "", " 123"]) expect(isValidPinFormat(bad)).toBe(false);
  });

  it("verifies the right PIN and rejects a wrong one", () => {
    const stored = hashPin("1234");
    expect(stored.startsWith("scrypt$N=16384$r=8$p=1$")).toBe(true);
    expect(verifyPin("1234", stored)).toBe(true);
    expect(verifyPin("1235", stored)).toBe(false);
  });

  it("salts each hash and rejects malformed stored values", () => {
    expect(hashPin("1234")).not.toBe(hashPin("1234"));
    expect(verifyPin("1234", "garbage")).toBe(false);
    expect(verifyPin("1234", "scrypt$N=x$r=8$p=1$AAAA$AAAA")).toBe(false);
  });
});

describe("viewer cookie", () => {
  const claims = {
    viewerId: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    pinVersion: 3,
  };
  const now = 1_700_000_000_000;

  it("round-trips", () => {
    const cookie = signViewerCookie(claims, now);
    expect(viewerIdFromCookie(cookie)).toBe(claims.viewerId);
    expect(verifyViewerCookie(cookie, claims, now + 1000)).toBe(true);
  });

  it("rejects a different account, viewer or pinVersion", () => {
    const cookie = signViewerCookie(claims, now);
    expect(verifyViewerCookie(cookie, { ...claims, accountId: "33333333-3333-4333-8333-333333333333" }, now)).toBe(false);
    expect(verifyViewerCookie(cookie, { ...claims, viewerId: "44444444-4444-4444-8444-444444444444" }, now)).toBe(false);
    expect(verifyViewerCookie(cookie, { ...claims, pinVersion: 4 }, now)).toBe(false);
  });

  it("rejects expired, tampered and malformed values", () => {
    const cookie = signViewerCookie(claims, now);
    expect(verifyViewerCookie(cookie, claims, now + 31 * 24 * 3600 * 1000)).toBe(false);
    const [id, exp, sig] = cookie.split(".");
    expect(verifyViewerCookie(`${id}.${Number(exp) + 999999}.${sig}`, claims, now)).toBe(false);
    expect(verifyViewerCookie(`${id}.${exp}.${sig.slice(0, -2)}xx`, claims, now)).toBe(false);
    expect(verifyViewerCookie("nonsense", claims, now)).toBe(false);
    expect(viewerIdFromCookie("nonsense")).toBeNull();
  });
});
