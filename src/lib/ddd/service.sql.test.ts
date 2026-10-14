/** Does the Dog Die through the database cache: when it is asked, what is kept, and what happens when it can't answer. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const h = vi.hoisted(() => ({ testDb: null as unknown as { db: import("@/lib/playlists/test-db").TestDb } }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("@/lib/playlists/test-db");
  h.testDb = await createTestDb();
  return { db: h.testDb.db };
});

import { dddItems, platformJobs } from "@/lib/db/schema";
import { resetClientMemory } from "./client";
import { EXPIRES_AFTER_MS, REFRESH_AFTER_MS, deleteExpiredDdd, dddFor, mayAsk, type DddLookup } from "./service";

let db: import("@/lib/playlists/test-db").TestDb;
beforeAll(() => {
  db = h.testDb.db;
});

let calls: string[] = [];
let n = 0;
let responder: (path: string) => { status?: number; body?: unknown; headers?: Record<string, string> };
const okHeaders = (remaining = 4000) => ({ "x-ratelimit-limit-month": "5000", "x-ratelimit-remaining-month": String(remaining), "x-ratelimit-limit-minute": "30", "x-ratelimit-remaining-minute": "29" });
const normal = (path: string) => {
  if (path.startsWith("/items?imdb=")) return { body: [{ id: 10, name: "Old Yeller", itemTypeName: "Movie" }], headers: okHeaders() };
  if (path === "/topics") return { body: [{ id: 153, name: "a dog dies" }, { id: 7, name: "there are jump scares" }], headers: okHeaders() };
  if (path === "/items/10/ratings") return { body: [{ yes: 1, voteSum: 0, topicId: 153, index1: -1, index2: -1, position1: 1, position2: 18, position3: 42, safePosition1: 1, safePosition2: 20, safePosition3: 5 }], headers: okHeaders() };
  if (path === "/items/10") return { body: { id: 10, name: "Old Yeller", topicItemStats: [{ topicId: 153, topicName: "a dog dies", yesSum: 57, noSum: 3, numComments: 7 }] }, headers: okHeaders() };
  return { status: 404, body: { error: "not_found" } };
};
const lookup = (): DddLookup => ({ imdbId: `tt${String(++n).padStart(7, "0")}`, tmdbId: null, kind: "movie" });

beforeEach(async () => {
  process.env.DDD_API_KEY = "test-key";
  calls = [];
  responder = normal;
  resetClientMemory();
  await db.delete(dddItems);
  await db.delete(platformJobs);
  vi.stubGlobal("fetch", async (url: string) => {
    const path = url.replace("https://www.doesthedogdie.com/api/v3", "");
    calls.push(path.split("?")[0] === "/items" ? "search" : path.replace(/\/items\/\d+/, "/items/:id"));
    const r = responder(path);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DDD_API_KEY;
});

describe("when it asks", () => {
  it("never asks when disabled, with no key, or with nothing to look the title up by", async () => {
    expect(await dddFor(lookup(), "disabled", "play")).toEqual({ status: "off" });
    expect(await dddFor({ imdbId: null, tmdbId: null, kind: "movie" }, "full", "play")).toEqual({ status: "off" });
    delete process.env.DDD_API_KEY;
    expect(await dddFor(lookup(), "full", "play")).toEqual({ status: "off" });
    expect(calls).toEqual([]);
  });
  it("by access level: full asks on a page and on play, limited only on play", () => {
    expect([mayAsk("full", "page"), mayAsk("full", "play"), mayAsk("limited", "page"), mayAsk("limited", "play"), mayAsk("disabled", "play")]).toEqual([true, true, false, true, false]);
  });
  it("limited does not ask when a page opens, and does when someone is about to play", async () => {
    const l = lookup();
    expect(await dddFor(l, "limited", "page")).toEqual({ status: "later" });
    expect(calls).toEqual([]);
    const r = await dddFor(l, "limited", "play");
    expect(r.status).toBe("ok");
    expect(calls).toEqual(["search", "/items/:id/ratings", "/topics"]); // the scenes only: no counts
  });
});

describe("what is kept", () => {
  it("asks once per title, then answers from what is kept for any server and any moment", async () => {
    const l = lookup();
    await dddFor(l, "full", "page", { needStats: true });
    const first = calls.length;
    expect(calls).toEqual(["search", "/items/:id/ratings", "/topics", "/items/:id"]);
    const again = await dddFor(l, "limited", "play");
    const third = await dddFor(l, "full", "page", { needStats: true });
    expect(calls.length).toBe(first);
    expect(again.status === "ok" && again.data.moments).toHaveLength(1);
    expect(third.status === "ok" && third.data.stats?.[0]).toMatchObject({ topicName: "a dog dies", yes: 57 });
  });
  it("only adds the counts when a page wants them and a play kept just the scenes, without asking for the scenes again", async () => {
    const l = lookup();
    await dddFor(l, "limited", "play");
    calls = [];
    const r = await dddFor(l, "full", "page", { needStats: true });
    expect(calls).toEqual(["/items/:id"]);
    expect(r.status === "ok" && r.data.stats).toHaveLength(1);
  });
  it("shares one request set between callers asking at the same time", async () => {
    const l = lookup();
    await Promise.all([dddFor(l, "full", "play"), dddFor(l, "full", "play"), dddFor(l, "limited", "play")]);
    expect(calls.filter((c) => c === "search")).toHaveLength(1);
  });
  it("remembers a title they don't have, without asking again soon", async () => {
    responder = (p) => (p.startsWith("/items?") ? { body: [], headers: okHeaders() } : normal(p));
    const l = lookup();
    expect(await dddFor(l, "full", "play")).toEqual({ status: "absent" });
    calls = [];
    expect(await dddFor(l, "full", "play")).toEqual({ status: "absent" });
    expect(calls).toEqual([]);
  });
  it("asks again after 25 days, and never uses what is older than 30", async () => {
    const l = lookup();
    await dddFor(l, "full", "play");
    const key = `imdb:${l.imdbId}`;
    await db.update(dddItems).set({ fetchedAt: new Date(Date.now() - REFRESH_AFTER_MS - 1000) }).where(eq(dddItems.key, key));
    calls = [];
    await dddFor(l, "full", "play");
    expect(calls).toContain("search".replace("search", "/items/:id/ratings"));
    await db.update(dddItems).set({ fetchedAt: new Date(Date.now() - EXPIRES_AFTER_MS - 1000) }).where(eq(dddItems.key, key));
    expect(await dddFor(l, "limited", "page")).toEqual({ status: "later" }); // too old to use, and this moment doesn't ask
    expect(await deleteExpiredDdd()).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(dddItems).where(eq(dddItems.key, key))).length).toBe(0);
  });
});

describe("when it can't answer", () => {
  it("says unavailable, and stops asking for the month once their allowance is gone", async () => {
    responder = () => ({ status: 429, body: { error: "monthly_limit_exceeded" }, headers: okHeaders(0) });
    const r = await dddFor(lookup(), "full", "play");
    expect(r).toEqual({ status: "unavailable", reason: "monthly" });
    calls = [];
    expect(await dddFor(lookup(), "full", "play")).toEqual({ status: "unavailable", reason: "monthly" });
    expect(calls).toEqual([]);
  });
  it("stops before the allowance is gone, keeping the last tenth", async () => {
    responder = (p) => ({ ...normal(p), headers: okHeaders(300) }); // 6% left of 5,000
    await dddFor(lookup(), "full", "play");
    calls = [];
    const r = await dddFor(lookup(), "full", "play");
    expect(r).toEqual({ status: "unavailable", reason: "budget" });
    expect(calls).toEqual([]);
  });
  it("falls back to what is kept when asking again fails", async () => {
    const l = lookup();
    await dddFor(l, "full", "play");
    await db.update(dddItems).set({ fetchedAt: new Date(Date.now() - REFRESH_AFTER_MS - 1000) }).where(eq(dddItems.key, `imdb:${l.imdbId}`));
    responder = () => ({ status: 500, body: {} });
    const r = await dddFor(l, "full", "play");
    expect(r.status).toBe("ok");
  });
  it("says unavailable on a server error or a refused key, and never throws", async () => {
    responder = () => ({ status: 500, body: {} });
    expect((await dddFor(lookup(), "full", "play")).status).toBe("unavailable");
    resetClientMemory();
    responder = () => ({ status: 401, body: { error: "invalid_api_key" } });
    expect(await dddFor(lookup(), "full", "play")).toEqual({ status: "unavailable", reason: "auth" });
  });
});
