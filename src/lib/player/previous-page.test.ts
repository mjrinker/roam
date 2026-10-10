import { beforeEach, describe, expect, it } from "vitest";
import { cameFrom, resetTrackedPages, trackPage } from "./previous-page";

beforeEach(resetTrackedPages);

describe("the page before this one", () => {
  it("is the details page when the player was opened from it", () => {
    trackPage("/s/1/library");
    trackPage("/s/1/title/9");
    trackPage("/s/1/watch/title/9");
    expect(cameFrom("/s/1/title/9")).toBe(true);
    expect(cameFrom("/s/1/title/9?x=1#y")).toBe(true);
    expect(cameFrom("/s/1/library")).toBe(false);
  });
  it("is nothing when the player was the first page, and ignores repeats of the same page", () => {
    trackPage("/s/1/watch/title/9");
    trackPage("/s/1/watch/title/9");
    expect(cameFrom("/s/1/title/9")).toBe(false);
  });
});
