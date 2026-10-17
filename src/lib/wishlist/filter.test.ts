import { describe, expect, it } from "vitest";
import { countsByKind, filterWishes, isDone } from "./filter";

const w = (kind: "movie" | "show" | "book", status: "wanted" | "claimed" | "got" = "wanted", onServer: unknown = null) => ({ kind, status, onServer });

describe("filtering the wishlist", () => {
  const items = [w("movie"), w("movie", "claimed"), w("movie", "got"), w("show"), w("book", "wanted", { titleId: "x" })];
  it("counts what is got, or already on the server, as done", () => {
    expect(items.map(isDone)).toEqual([false, false, true, false, true]);
  });
  it("hides what is done unless asked, and narrows by kind", () => {
    expect(filterWishes(items, { kind: "all", showDone: false })).toHaveLength(3);
    expect(filterWishes(items, { kind: "all", showDone: true })).toHaveLength(5);
    expect(filterWishes(items, { kind: "movie", showDone: false })).toHaveLength(2);
    expect(filterWishes(items, { kind: "movie", showDone: true })).toHaveLength(3);
    expect(filterWishes(items, { kind: "show", showDone: true })).toHaveLength(1);
  });
  it("counts each kind without the done ones", () => {
    expect(countsByKind(items)).toEqual({ all: 3, movie: 2, show: 1, audiobook: 0, book: 0, album: 0, other: 0 });
  });
});
