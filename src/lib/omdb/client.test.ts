import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OmdbError, OmdbRateLimitedError, getOmdbRatings, isOmdbConfigured } from "./client";

beforeAll(() => {
  vi.stubEnv("OMDB_API_KEY", "test-key");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );
}

describe("isOmdbConfigured", () => {
  it("reflects whether the env var is set", () => {
    expect(isOmdbConfigured()).toBe(true);
    vi.stubEnv("OMDB_API_KEY", "");
    expect(isOmdbConfigured()).toBe(false);
    vi.stubEnv("OMDB_API_KEY", "test-key");
  });
});

describe("getOmdbRatings", () => {
  it("returns parsed ratings on a hit", async () => {
    mockFetchOnce(200, { imdbRating: "8.1", Ratings: [], Response: "True" });
    expect(await getOmdbRatings("tt1")).toMatchObject({ imdbRating: 8.1 });
  });

  it("returns null for a miss (not an error)", async () => {
    mockFetchOnce(200, { Response: "False", Error: "Movie not found!" });
    expect(await getOmdbRatings("tt404")).toBeNull();
  });

  it("throws OmdbRateLimitedError on a 429", async () => {
    mockFetchOnce(429, {});
    await expect(getOmdbRatings("tt1")).rejects.toBeInstanceOf(OmdbRateLimitedError);
  });

  it("throws OmdbRateLimitedError when the limit message comes back as a 200", async () => {
    mockFetchOnce(200, { Response: "False", Error: "Request limit reached!" });
    await expect(getOmdbRatings("tt1")).rejects.toBeInstanceOf(OmdbRateLimitedError);
  });

  it("throws a plain OmdbError on an invalid key", async () => {
    mockFetchOnce(401, {});
    await expect(getOmdbRatings("tt1")).rejects.toBeInstanceOf(OmdbError);
  });
});
