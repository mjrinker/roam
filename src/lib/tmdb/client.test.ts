import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findTmdbIdByImdbId } from "./client";

describe("findTmdbIdByImdbId", () => {
  beforeEach(() => {
    vi.stubEnv("TMDB_READ_ACCESS_TOKEN", "token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("looks the id up via /find and returns the movie hit", async () => {
    const fetchMock = stubFetch({ movie_results: [{ id: 42 }], tv_results: [{ id: 7 }] });
    await expect(findTmdbIdByImdbId("tt0187078", "movie")).resolves.toBe(42);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/find/tt0187078");
    expect(url).toContain("external_source=imdb_id");
  });

  it("returns the tv hit for shows", async () => {
    stubFetch({ movie_results: [{ id: 42 }], tv_results: [{ id: 7 }] });
    await expect(findTmdbIdByImdbId("tt0000001", "show")).resolves.toBe(7);
  });

  it("returns null when TMDB has nothing of that kind", async () => {
    stubFetch({ movie_results: [], tv_results: [] });
    await expect(findTmdbIdByImdbId("tt0000002", "movie")).resolves.toBeNull();
  });
});
