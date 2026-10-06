import { describe, expect, it } from "vitest";
import { decideSwipe } from "./swipe";

const swipe = (dx: number, dy = 0, ms = 400, fingers = 1) => decideSwipe({ dx, dy, ms, fingers });

describe("decideSwipe", () => {
  it("left means next, right means previous", () => {
    expect(swipe(-100)).toBe("next");
    expect(swipe(100)).toBe("prev");
  });
  it("ignores a short, slow movement but accepts a short quick flick", () => {
    expect(swipe(-40, 0, 400)).toBeNull();
    expect(swipe(-40, 0, 150)).toBe("next");
    expect(swipe(-10, 0, 50)).toBeNull();
  });
  it("ignores mostly vertical movement and multi-finger gestures", () => {
    expect(swipe(-80, 70)).toBeNull();
    expect(swipe(-100, 40)).toBe("next");
    expect(swipe(-200, 0, 100, 2)).toBeNull();
    expect(swipe(-200, 0, 100, 0)).toBeNull();
  });
});
