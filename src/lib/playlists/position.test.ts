import { describe, expect, it } from "vitest";
import { POSITION_GAP, appendPosition, planMove } from "./position";

describe("appendPosition", () => {
  it("starts an empty playlist at one gap and appends one gap past the last", () => {
    expect(appendPosition(null)).toBe(POSITION_GAP);
    expect(appendPosition(5000)).toBe(5000 + POSITION_GAP);
  });
});

describe("planMove", () => {
  it("puts an item at the midpoint between its neighbours", () => {
    expect(planMove(1024, 2048)).toEqual({ position: 1536 });
    expect(planMove(1000, 1005)).toEqual({ position: 1002 });
  });

  it("moves to the end one gap past the last item", () => {
    expect(planMove(4096, null)).toEqual({ position: 4096 + POSITION_GAP });
  });

  it("moves to the top using 0 as the lower bound", () => {
    expect(planMove(null, 1024)).toEqual({ position: 512 });
  });

  it("moves into an empty playlist", () => {
    expect(planMove(null, null)).toEqual({ position: POSITION_GAP });
  });

  it("asks for a renumber when no integer fits between the bounds", () => {
    expect(planMove(10, 11)).toEqual({ renumber: true });
    expect(planMove(10, 10)).toEqual({ renumber: true });
    expect(planMove(null, 1)).toEqual({ renumber: true });
    expect(planMove(null, 0)).toEqual({ renumber: true });
  });

  it("still fits when the bounds are exactly 2 apart", () => {
    expect(planMove(10, 12)).toEqual({ position: 11 });
  });
});
