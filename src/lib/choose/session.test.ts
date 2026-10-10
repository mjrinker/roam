import { describe, expect, it } from "vitest";
import { formatChooseRuntime, otherSide, ROUNDS_BEFORE_ASKING } from "./session";
import type { ChooseItem } from "./pick";

const item = (id: string) => ({ id }) as ChooseItem;

describe("the choosing session's small parts", () => {
  it("asks after fifteen rounds", () => {
    expect(ROUNDS_BEFORE_ASKING).toBe(15);
  });
  it("puts the kept item and the new one in either order, both always there", () => {
    expect(otherSide(item("a"), item("b"), () => 0.2).map((i) => i.id)).toEqual(["a", "b"]);
    expect(otherSide(item("a"), item("b"), () => 0.8).map((i) => i.id)).toEqual(["b", "a"]);
  });
  it("words a length of time", () => {
    expect([formatChooseRuntime(5400), formatChooseRuntime(125), formatChooseRuntime(7200), formatChooseRuntime(30), formatChooseRuntime(null)]).toEqual(["1h 30m", "2m", "2h", null, null]);
  });
});
