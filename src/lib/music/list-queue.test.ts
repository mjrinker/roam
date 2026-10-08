import { describe, expect, it } from "vitest";
import { nextIndex, previousStep, shuffled } from "./list-queue";

describe("list queue", () => {
  it("moves to the next song until the last", () => {
    expect(nextIndex({ ids: ["a", "b", "c"], index: 0 })).toBe(1);
    expect(nextIndex({ ids: ["a", "b", "c"], index: 2 })).toBeNull();
    expect(nextIndex({ ids: [], index: 0 })).toBeNull();
  });
  it("restarts a song heard for a while or the first song, and otherwise goes back", () => {
    const q = { ids: ["a", "b", "c"], index: 2 };
    expect(previousStep(q, 10)).toEqual({ restart: true });
    expect(previousStep(q, 3)).toEqual({ restart: false, index: 1 });
    expect(previousStep(q, 0)).toEqual({ restart: false, index: 1 });
    expect(previousStep({ ids: ["a", "b"], index: 0 }, 0)).toEqual({ restart: true });
  });
  it("shuffles into a permutation, keeping the chosen first song first, and never loses or repeats one", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `t${i}`);
    for (let n = 0; n < 20; n++) {
      const out = shuffled(ids, "t7");
      expect(out[0]).toBe("t7");
      expect([...out].sort()).toEqual([...ids].sort());
    }
    expect(shuffled(ids)).toHaveLength(30);
    expect(shuffled(ids, "not-there").sort()).toEqual([...ids].sort());
    expect(shuffled([], "x")).toEqual([]);
    // actually reorders (deterministic rng that always picks index 0)
    expect(shuffled(["a", "b", "c", "d"], undefined, () => 0)).not.toEqual(["a", "b", "c", "d"]);
  });
});
