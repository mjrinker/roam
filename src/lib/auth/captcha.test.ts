import { describe, expect, it, vi } from "vitest";
import { captchaOption, captchaSatisfied, captchaSiteKey } from "./captcha";
import { createAccount, requestMagicLink, signInAsGuest, signInWithPassword } from "./sign-in-calls";

describe("captcha helpers", () => {
  it("reads the site key, treating blank as not configured", () => {
    expect(captchaSiteKey("0x4AAAA")).toBe("0x4AAAA");
    expect(captchaSiteKey("  0x4AAAA \n")).toBe("0x4AAAA");
    for (const none of [undefined, "", "   "]) expect(captchaSiteKey(none)).toBeNull();
  });
  it("adds a token to a call only when there is one", () => {
    expect(captchaOption("tok")).toEqual({ captchaToken: "tok" });
    for (const none of [null, undefined, ""]) expect(captchaOption(none)).toEqual({});
  });
  it("lets a button be pressed with no CAPTCHA configured, and otherwise only with a token", () => {
    expect(captchaSatisfied(false, null)).toBe(true);
    expect(captchaSatisfied(true, null)).toBe(false);
    expect(captchaSatisfied(true, "")).toBe(false);
    expect(captchaSatisfied(true, "tok")).toBe(true);
  });
});

describe("sign-in calls carry the token on every call Supabase would refuse without one", () => {
  const auth = () => ({
    signInWithOtp: vi.fn(async () => ({ error: null })),
    signUp: vi.fn(async () => ({ error: null })),
    signInWithPassword: vi.fn(async () => ({ error: null })),
    signInAnonymously: vi.fn(async () => ({ error: null })),
  });
  const cap = { captchaToken: "tok" };

  it("email link", async () => {
    const a = auth();
    await requestMagicLink(a as never, { email: "a@b.c", redirectTo: "https://x/cb", captcha: cap });
    expect(a.signInWithOtp).toHaveBeenCalledWith({ email: "a@b.c", options: { emailRedirectTo: "https://x/cb", captchaToken: "tok" } });
  });
  it("create account", async () => {
    const a = auth();
    await createAccount(a as never, { email: "a@b.c", password: "pw123456", captcha: cap });
    expect(a.signUp).toHaveBeenCalledWith({ email: "a@b.c", password: "pw123456", options: { captchaToken: "tok" } });
  });
  it("password sign-in", async () => {
    const a = auth();
    await signInWithPassword(a as never, { email: "a@b.c", password: "pw123456", captcha: cap });
    expect(a.signInWithPassword).toHaveBeenCalledWith({ email: "a@b.c", password: "pw123456", options: { captchaToken: "tok" } });
  });
  it("guest sign-in", async () => {
    const a = auth();
    await signInAsGuest(a as never, { captcha: cap });
    expect(a.signInAnonymously).toHaveBeenCalledWith({ options: { captchaToken: "tok" } });
  });
  it("send no token field at all when CAPTCHA is not configured", async () => {
    const a = auth();
    await signInAsGuest(a as never, { captcha: {} });
    await requestMagicLink(a as never, { email: "a@b.c", redirectTo: "r", captcha: {} });
    expect(a.signInAnonymously).toHaveBeenCalledWith({ options: {} });
    expect(a.signInWithOtp).toHaveBeenCalledWith({ email: "a@b.c", options: { emailRedirectTo: "r" } });
  });
});
