import { describe, expect, it } from "vitest";
import { buildRadio, shareWeights, similarWeight, SEED_SHARE, type RadioArtist } from "./radio";

/** A repeatable source of "randomness" (mulberry32). */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const songs = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const artistOf = (id: string) => id[0];

describe("buildRadio", () => {
  const artists = (): RadioArtist[] => [
    { id: "a", songs: songs("a", 30), weight: 0.3 },
    { id: "b", songs: songs("b", 30), weight: 0.4 },
    { id: "c", songs: songs("c", 30), weight: 0.3 },
  ];

  it("gives the length asked for, each song once, only songs that were offered", () => {
    const out = buildRadio({ artists: artists(), length: 50, random: seeded(1) });
    expect(out).toHaveLength(50);
    expect(new Set(out).size).toBe(50);
    expect(out.every((id) => /^[abc]\d+$/.test(id))).toBe(true);
  });

  it("never plays the same artist twice in a row while another has songs left", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const out = buildRadio({ artists: artists(), length: 80, random: seeded(seed) });
      for (let i = 1; i < out.length; i++) expect(artistOf(out[i])).not.toBe(artistOf(out[i - 1]));
    }
  });

  it("plays artists in proportion to their weights", () => {
    const heavy: RadioArtist[] = [
      { id: "a", songs: songs("a", 400), weight: SEED_SHARE },
      { id: "b", songs: songs("b", 400), weight: 1 - SEED_SHARE },
    ];
    // (With two artists the no-repeat rule would force alternation, so weigh three: the seed against two others.)
    const three: RadioArtist[] = [heavy[0], { id: "b", songs: songs("b", 400), weight: 0.35 }, { id: "c", songs: songs("c", 400), weight: 0.35 }];
    const out = buildRadio({ artists: three, length: 300, random: seeded(7) });
    const share = out.filter((id) => id.startsWith("a")).length / out.length;
    expect(share).toBeGreaterThan(0.22);
    expect(share).toBeLessThan(0.38);
  });

  it("starts with the chosen song, once, and carries on from there", () => {
    const out = buildRadio({ artists: artists(), length: 20, firstSongId: "b7", random: seeded(3) });
    expect(out[0]).toBe("b7");
    expect(out.filter((id) => id === "b7")).toHaveLength(1);
    expect(artistOf(out[1])).not.toBe("b");
    expect(buildRadio({ artists: artists(), length: 5, firstSongId: "zzz", random: seeded(3) })).toHaveLength(5); // a song not in the pool is just not first
  });

  it("stops when the songs run out, repeats an artist only when it is the only one left, and ignores artists with nothing to play", () => {
    const out = buildRadio({ artists: [{ id: "a", songs: ["a0", "a1"], weight: 1 }, { id: "b", songs: songs("b", 5), weight: 1 }, { id: "c", songs: [], weight: 5 }, { id: "d", songs: ["d0"], weight: 0 }], length: 100, random: seeded(4) });
    expect(out).toHaveLength(7);
    expect(out.some((id) => id.startsWith("c") || id.startsWith("d"))).toBe(false);
    expect(buildRadio({ artists: [], random: seeded(1) })).toEqual([]);
    expect(buildRadio({ artists: [{ id: "a", songs: ["a0", "a0", "a1"], weight: 1 }], length: 10, random: seeded(1) }).sort()).toEqual(["a0", "a1"]); // a song listed twice plays once
  });
});

describe("weights", () => {
  it("counts the closest artist most and never drops one to nothing", () => {
    const w = [0, 1, 2, 3, 10].map(similarWeight);
    expect(w[0]).toBe(1);
    expect([...w].sort((x, y) => y - x)).toEqual(w);
    expect(w[4]).toBeGreaterThan(0.2);
  });
  it("gives the seed its share when there are others to share the rest, and everything to the seed when there are none", () => {
    const { seed, others } = shareWeights(1, [1, 0.5, 0.5]);
    expect(seed).toBe(SEED_SHARE);
    expect(others.reduce((n, x) => n + x, 0)).toBeCloseTo(1 - SEED_SHARE, 10);
    expect(others[0]).toBeCloseTo((1 - SEED_SHARE) / 2, 10);
    expect(shareWeights(1, [])).toEqual({ seed: 1, others: [] });
  });
});
