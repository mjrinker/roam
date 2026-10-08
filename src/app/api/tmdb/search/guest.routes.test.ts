/** A guest (an anonymous demo visitor) can't spend the TMDB quota; a normal account still can. */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ profile: null as null | { id: string; isGuest: boolean }, searched: 0 }));
vi.mock("@/lib/auth/guards", () => ({ getCurrentProfile: async () => h.profile }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
vi.mock("@/lib/tmdb/client", () => ({
  searchMovies: async () => (h.searched++, []),
  searchShows: async () => (h.searched++, []),
  posterUrl: () => null,
}));

import { GET } from "./route";

const get = () => GET(new Request("http://x/api/tmdb/search?q=matrix&kind=movie"));

describe("GET /api/tmdb/search", () => {
  it("refuses a guest without calling TMDB, and still serves a normal account", async () => {
    h.profile = { id: "g", isGuest: true };
    const refused = await get();
    expect(refused.status).toBe(403);
    expect(h.searched).toBe(0);
    h.profile = { id: "u", isGuest: false };
    expect((await get()).status).toBe(200);
    expect(h.searched).toBe(1);
  });
  it("still needs a signed-in account", async () => {
    h.profile = null;
    expect((await get()).status).toBe(401);
  });
});
