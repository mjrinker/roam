import { describe, expect, it } from "vitest";
import { shouldContinueQueue } from "./queue-handoff";

const queue = { playlistId: "p1", itemId: "i1" };

describe("shouldContinueQueue", () => {
  it("continues when the listener is browsing elsewhere or on this same playlist's queue", () => {
    expect(shouldContinueQueue("", queue)).toBe(true);
    expect(shouldContinueQueue("?tab=x", queue)).toBe(true);
    expect(shouldContinueQueue("?playlist=p1&item=i9", queue)).toBe(true);
  });

  it("stays out of the way when they're on a different playlist's queue", () => {
    expect(shouldContinueQueue("?playlist=p2&item=i1", queue)).toBe(false);
  });
});
