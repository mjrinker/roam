import { describe, expect, it } from "vitest";
import { historyBody, Trakt, TraktError, traktConfig } from "./client";

const config = { clientId: "cid", clientSecret: "sec" };
function trakt(answers: Record<string, () => Response>) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.trakt.tv", "");
    calls.push({ url: path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> });
    const a = answers[path];
    return a ? a() : new Response("{}", { status: 404 });
  };
  return { client: new Trakt(config, impl, () => new Date("2026-10-18T12:00:00Z")), calls };
}

describe("Trakt configuration", () => {
  it("is off until both keys are set", () => {
    expect(traktConfig({})).toBeNull();
    expect(traktConfig({ TRAKT_CLIENT_ID: "a" })).toBeNull();
    expect(traktConfig({ TRAKT_CLIENT_ID: "a", TRAKT_CLIENT_SECRET: "b" })).toEqual({ clientId: "a", clientSecret: "b" });
  });
});

describe("signing in with a code", () => {
  it("starts a device code, waits while pending, and gets tokens once approved", async () => {
    const { client, calls } = trakt({
      "/oauth/device/code": () => Response.json({ device_code: "dev", user_code: "ABCD1234", verification_url: "https://trakt.tv/activate", expires_in: 600, interval: 5 }),
    });
    expect(await client.startDevice()).toEqual({ deviceCode: "dev", userCode: "ABCD1234", verificationUrl: "https://trakt.tv/activate", expiresIn: 600, interval: 5 });
    expect(calls[0].headers["trakt-api-key"]).toBe("cid");
    const pending = trakt({ "/oauth/device/token": () => new Response("{}", { status: 400 }) });
    expect(await pending.client.pollDevice("dev")).toBe("pending");
    const gone = trakt({ "/oauth/device/token": () => new Response("{}", { status: 410 }) });
    expect(await gone.client.pollDevice("dev")).toBe("expired");
    const ok = trakt({ "/oauth/device/token": () => Response.json({ access_token: "a", refresh_token: "r", expires_in: 7200, created_at: 1_790_000_000 }) });
    expect(await ok.client.pollDevice("dev")).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: new Date((1_790_000_000 + 7200) * 1000) });
  });
  it("says in words when it can't refresh or can't be reached", async () => {
    const { client } = trakt({ "/oauth/token": () => new Response("{}", { status: 401 }) });
    await expect(client.refresh("r")).rejects.toThrow(/connect it again/);
    const down = new Trakt(config, async () => { throw new Error("offline"); });
    await expect(down.startDevice()).rejects.toBeInstanceOf(TraktError);
  });
});

describe("sending and reading", () => {
  it("names a movie, and an episode through its show, by TMDB id; and sends nothing without one", () => {
    const at = new Date("2026-01-02T03:04:05Z");
    expect(historyBody({ kind: "movie", title: "Heat", year: 1995, tmdbId: 949 }, at)).toEqual({ movies: [{ ids: { tmdb: 949 }, watched_at: at.toISOString() }] });
    expect(historyBody({ kind: "episode", title: "Lost", year: 2004, tmdbId: 4607, season: 1, number: 2 }, at)).toEqual({ shows: [{ ids: { tmdb: 4607 }, seasons: [{ number: 1, episodes: [{ number: 2, watched_at: at.toISOString() }] }] }] });
    expect(historyBody({ kind: "movie", title: "No id", year: null, tmdbId: null }, at)).toBeNull();
    expect(historyBody({ kind: "show", title: "Whole show", year: null, tmdbId: 1 }, at)).toBeNull();
  });
  it("posts history and ratings with the token", async () => {
    const { client, calls } = trakt({ "/sync/history": () => Response.json({}), "/sync/ratings": () => Response.json({}) });
    await client.addToHistory("tok", { kind: "movie", title: "Heat", year: 1995, tmdbId: 949 }, new Date("2026-01-01T00:00:00Z"));
    await client.rate("tok", { kind: "episode", title: "Lost", year: 2004, tmdbId: 4607, season: 1, number: 2 }, 9);
    expect(calls.map((c) => [c.method, c.url, c.headers.Authorization])).toEqual([["POST", "/sync/history", "Bearer tok"], ["POST", "/sync/ratings", "Bearer tok"]]);
    expect(calls[1].body).toEqual({ shows: [{ ids: { tmdb: 4607 }, seasons: [{ number: 1, episodes: [{ number: 2, rating: 9 }] }] }] });
  });
  it("reads watched movies and episodes and ratings as a profile's data", async () => {
    const { client } = trakt({
      "/sync/watched/movies": () => Response.json([{ last_watched_at: "2025-05-05T00:00:00Z", movie: { title: "Heat", year: 1995, ids: { tmdb: 949 } } }]),
      "/sync/watched/shows": () => Response.json([{ show: { title: "Lost", year: 2004, ids: { tmdb: 4607 } }, seasons: [{ number: 1, episodes: [{ number: 1, last_watched_at: "2025-06-06T00:00:00Z" }, { number: 2 }] }] }]),
      "/sync/ratings/movies": () => Response.json([{ rating: 9, movie: { title: "Heat", year: 1995, ids: { tmdb: 949 } } }]),
      "/sync/ratings/shows": () => Response.json([{ rating: 0, show: { title: "Bad", ids: {} } }]),
    });
    const data = await client.pull("tok");
    expect(data.watched.map((w) => [w.ref.kind, w.ref.title, "season" in w.ref ? `${w.ref.season}x${w.ref.number}` : "", w.at])).toEqual([
      ["movie", "Heat", "", "2025-05-05T00:00:00Z"],
      ["episode", "Lost", "1x1", "2025-06-06T00:00:00Z"],
      ["episode", "Lost", "1x2", null],
    ]);
    expect(data.ratings.map((r) => [r.ref.title, r.halfStars])).toEqual([["Heat", 9]]);
  });
});
