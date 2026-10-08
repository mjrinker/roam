import { describe, expect, it, vi } from "vitest";
import { mintTvSession } from "./session";

const admin = (over: { user?: unknown; link?: unknown } = {}) => ({
  getUserById: vi.fn(async () => over.user ?? { data: { user: { email: "me@example.com" } }, error: null }),
  generateLink: vi.fn(async () => over.link ?? { data: { properties: { hashed_token: "hash123" } }, error: null }),
});

describe("mintTvSession", () => {
  it("asks for a one-time token for the account's email and redeems it", async () => {
    const a = admin();
    const redeem = vi.fn(async () => ({ error: null }));
    expect(await mintTvSession("acct", { admin: a as never, signInWithToken: redeem })).toEqual({ ok: true });
    expect(a.getUserById).toHaveBeenCalledWith("acct");
    expect(a.generateLink).toHaveBeenCalledWith({ type: "magiclink", email: "me@example.com" });
    expect(redeem).toHaveBeenCalledWith("hash123");
  });
  it("refuses an account with no email (a guest), without asking for any token", async () => {
    const a = admin({ user: { data: { user: { email: null } }, error: null } });
    const redeem = vi.fn();
    expect(await mintTvSession("g", { admin: a as never, signInWithToken: redeem })).toEqual({ ok: false, reason: "no_email" });
    expect(a.generateLink).not.toHaveBeenCalled();
    expect(redeem).not.toHaveBeenCalled();
    expect(await mintTvSession("g", { admin: admin({ user: { data: { user: null }, error: { message: "nope" } } }) as never, signInWithToken: redeem })).toEqual({ ok: false, reason: "no_email" });
  });
  it("fails cleanly when Supabase won't make a token or won't accept it", async () => {
    const redeem = vi.fn(async () => ({ error: { message: "expired" } }));
    expect(await mintTvSession("a", { admin: admin({ link: { data: null, error: { message: "x" } } }) as never, signInWithToken: redeem })).toEqual({ ok: false, reason: "failed" });
    expect(redeem).not.toHaveBeenCalled();
    expect(await mintTvSession("a", { admin: admin({ link: { data: { properties: {} }, error: null } }) as never, signInWithToken: redeem })).toEqual({ ok: false, reason: "failed" });
    expect(await mintTvSession("a", { admin: admin() as never, signInWithToken: redeem })).toEqual({ ok: false, reason: "failed" });
  });
});
