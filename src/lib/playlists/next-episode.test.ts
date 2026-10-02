import { describe, expect, it } from "vitest";
import { nextEpisodeAfter, pickStartEpisode, playingOrder, type EpisodeCandidate } from "./next-episode";

const ep = (id: string, season: number, episode: number, over: Partial<EpisodeCandidate> = {}): EpisodeCandidate => ({
  id,
  seasonNumber: season,
  episodeNumber: episode,
  finished: false,
  progressSeconds: 0,
  updatedAt: null,
  ...over,
});

describe("playingOrder", () => {
  it("orders by season then episode, with specials (season 0) last", () => {
    const order = playingOrder([ep("special", 0, 1), ep("s2e1", 2, 1), ep("s1e2", 1, 2), ep("s1e1", 1, 1)]);
    expect(order.map((c) => c.id)).toEqual(["s1e1", "s1e2", "s2e1", "special"]);
  });

  it("breaks ties by id", () => {
    expect(playingOrder([ep("b", 1, 1), ep("a", 1, 1)]).map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("pickStartEpisode", () => {
  it("is null with no candidates", () => {
    expect(pickStartEpisode([])).toBeNull();
  });

  it("starts at the first episode of an unwatched show", () => {
    expect(pickStartEpisode([ep("e2", 1, 2), ep("e1", 1, 1)])).toEqual({ episodeId: "e1", replay: false });
  });

  it("resumes the most recently updated in-progress episode", () => {
    const pick = pickStartEpisode([
      ep("e1", 1, 1, { finished: true }),
      ep("e2", 1, 2, { progressSeconds: 100, updatedAt: new Date("2026-01-01") }),
      ep("e3", 1, 3, { progressSeconds: 50, updatedAt: new Date("2026-02-01") }),
    ]);
    expect(pick).toEqual({ episodeId: "e3", replay: false });
  });

  it("moves to the next unfinished episode when none is in progress", () => {
    const pick = pickStartEpisode([ep("e1", 1, 1, { finished: true }), ep("e2", 1, 2), ep("e3", 1, 3)]);
    expect(pick).toEqual({ episodeId: "e2", replay: false });
  });

  it("ignores a finished episode's leftover progress", () => {
    const pick = pickStartEpisode([
      ep("e1", 1, 1, { finished: true, progressSeconds: 999, updatedAt: new Date("2026-03-01") }),
      ep("e2", 1, 2),
    ]);
    expect(pick).toEqual({ episodeId: "e2", replay: false });
  });

  it("replays from the first non-special episode when everything is finished", () => {
    const pick = pickStartEpisode([
      ep("special", 0, 1, { finished: true }),
      ep("e2", 1, 2, { finished: true }),
      ep("e1", 1, 1, { finished: true }),
    ]);
    expect(pick).toEqual({ episodeId: "e1", replay: true });
  });

  it("replays from the first special when the show only has specials", () => {
    const pick = pickStartEpisode([ep("sp2", 0, 2, { finished: true }), ep("sp1", 0, 1, { finished: true })]);
    expect(pick).toEqual({ episodeId: "sp1", replay: true });
  });
});

describe("nextEpisodeAfter", () => {
  const show = [
    ep("e1", 1, 1, { finished: true }),
    ep("e2", 1, 2),
    ep("e3", 1, 3, { finished: true }),
    ep("e4", 1, 4),
  ];

  it("skips finished episodes outside replay mode", () => {
    expect(nextEpisodeAfter(show, "e1", false)).toBe("e2");
    expect(nextEpisodeAfter(show, "e2", false)).toBe("e4");
    expect(nextEpisodeAfter(show, "e4", false)).toBeNull();
  });

  it("steps through every episode in replay mode", () => {
    expect(nextEpisodeAfter(show, "e1", true)).toBe("e2");
    expect(nextEpisodeAfter(show, "e2", true)).toBe("e3");
    expect(nextEpisodeAfter(show, "e4", true)).toBeNull();
  });

  it("is null for an episode that is not a candidate", () => {
    expect(nextEpisodeAfter(show, "ghost", false)).toBeNull();
    expect(nextEpisodeAfter(show, "ghost", true)).toBeNull();
  });

  it("reaches specials after the last regular episode", () => {
    const withSpecial = [ep("e1", 1, 1), ep("sp", 0, 1)];
    expect(nextEpisodeAfter(withSpecial, "e1", false)).toBe("sp");
  });
});
