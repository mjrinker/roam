import { describe, expect, it } from "vitest";
import { OFF, PAUSE_HOLD_MS, PLAYING_TTL_MS, decideAvailability, limitApplies, sessionIsLive, unavailableMessage, type OwnershipSettings } from "./rules";

const on: OwnershipSettings = { enabled: true, claimMode: "review", limitConcurrent: false, limitKinds: ["movies", "shows"] };
const limited: OwnershipSettings = { ...on, limitConcurrent: true };
const owner = (accountId: string, shared = true) => ({ accountId, shared });
const ask = (settings: OwnershipSettings, owners: ReturnType<typeof owner>[], over: Partial<{ accountId: string; libraryKind: string; othersPlaying: number }> = {}) =>
  decideAvailability({ settings, libraryKind: over.libraryKind ?? "movies", accountId: over.accountId ?? "me", owners, othersPlaying: over.othersPlaying ?? 0 });

describe("a server that doesn't track ownership", () => {
  it("lets everything play, whatever the data says", () => {
    expect(ask(OFF, [owner("a", false)])).toEqual({ ok: true });
    expect(ask({ ...OFF, limitConcurrent: true, limitKinds: ["movies"] }, [owner("a")], { othersPlaying: 9 })).toEqual({ ok: true });
  });
});

describe("a title nobody owns", () => {
  it("can be played by anyone, with no limit", () => {
    expect(ask(limited, [], { othersPlaying: 50 })).toEqual({ ok: true });
  });
});

describe("withdrawing", () => {
  it("blocks everyone but an owner once every copy is withdrawn", () => {
    expect(ask(on, [owner("a", false)])).toEqual({ ok: false, code: "withdrawn" });
    expect(ask(on, [owner("a", false), owner("b", false)])).toEqual({ ok: false, code: "withdrawn" });
  });
  it("still lets a household play its own withdrawn copy", () => {
    expect(ask(on, [owner("me", false)])).toEqual({ ok: true });
    expect(ask(limited, [owner("me", false), owner("b")], { othersPlaying: 1 })).toEqual({ ok: true }); // its own copy: no shared copy is used
  });
  it("leaves the title playable while another owner still shares", () => {
    expect(ask(on, [owner("a", false), owner("b")])).toEqual({ ok: true });
  });
  it("lets an owner who shares play like anyone", () => {
    expect(ask(on, [owner("me"), owner("b", false)])).toEqual({ ok: true });
  });
});

describe("the limit on playing at once", () => {
  it("allows as many as there are shared copies", () => {
    const two = [owner("a"), owner("b")];
    expect(ask(limited, two, { othersPlaying: 0 })).toEqual({ ok: true });
    expect(ask(limited, two, { othersPlaying: 1 })).toEqual({ ok: true });
    expect(ask(limited, two, { othersPlaying: 2 })).toEqual({ ok: false, code: "busy", copies: 2, inUse: 2 });
  });
  it("counts only shared copies", () => {
    expect(ask(limited, [owner("a"), owner("b", false)], { othersPlaying: 1 })).toEqual({ ok: false, code: "busy", copies: 1, inUse: 1 });
  });
  it("applies only to the kinds the server chose", () => {
    expect(ask(limited, [owner("a")], { libraryKind: "audiobooks", othersPlaying: 3 })).toEqual({ ok: true });
    expect(limitApplies(limited, "shows")).toBe(true);
    expect(limitApplies(limited, "music")).toBe(false);
    expect(limitApplies(on, "movies")).toBe(false);
  });
  it("gives owners no priority over the count", () => {
    expect(ask(limited, [owner("me")], { othersPlaying: 1 })).toEqual({ ok: false, code: "busy", copies: 1, inUse: 1 });
  });
});

describe("how long a player holds its place", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  it("lasts while the heartbeat keeps coming, and goes when it stops", () => {
    expect(sessionIsLive({ lastSeenAt: ago(30_000), pausedAt: null }, now)).toBe(true);
    expect(sessionIsLive({ lastSeenAt: ago(PLAYING_TTL_MS + 1), pausedAt: null }, now)).toBe(false);
  });
  it("a paused player keeps its place for ten minutes, then lets go", () => {
    expect(sessionIsLive({ lastSeenAt: ago(PAUSE_HOLD_MS - 60_000), pausedAt: ago(PAUSE_HOLD_MS - 60_000) }, now)).toBe(true);
    expect(sessionIsLive({ lastSeenAt: ago(5_000), pausedAt: ago(PAUSE_HOLD_MS + 1) }, now)).toBe(false);
  });
});

describe("unavailableMessage", () => {
  it("says what is wrong in plain words", () => {
    expect(unavailableMessage({ ok: false, code: "withdrawn" })).toMatch(/withdrawn/);
    expect(unavailableMessage({ ok: false, code: "busy", copies: 1, inUse: 1 })).toMatch(/only copy/);
    expect(unavailableMessage({ ok: false, code: "busy", copies: 3, inUse: 3 })).toMatch(/All 3 copies/);
  });
});
