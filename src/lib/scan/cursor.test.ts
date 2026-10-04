import { describe, expect, it } from "vitest";
import { entriesAfterCursor, planScan, sortForScan } from "./cursor";

const e = (name: string, id = name) => ({ id, name });

describe("sortForScan", () => {
  it("sorts numerically-aware and deterministically", () => {
    const sorted = sortForScan([e("Book 10"), e("Book 2"), e("Alpha"), e("Book 1")]);
    expect(sorted.map((x) => x.name)).toEqual(["Alpha", "Book 1", "Book 2", "Book 10"]);
  });

  it("breaks name ties by id", () => {
    const sorted = sortForScan([e("Same", "b"), e("Same", "a")]);
    expect(sorted.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("entriesAfterCursor", () => {
  const sorted = sortForScan([e("A"), e("B"), e("C 2"), e("C 10")]);

  it("returns everything with no cursor", () => {
    expect(entriesAfterCursor(sorted, null)).toHaveLength(4);
  });

  it("returns only entries strictly after the cursor folder", () => {
    expect(entriesAfterCursor(sorted, { folder: "B" }).map((x) => x.name)).toEqual(["C 2", "C 10"]);
  });

  it("uses the same numeric ordering as the sort", () => {
    expect(entriesAfterCursor(sorted, { folder: "C 2" }).map((x) => x.name)).toEqual(["C 10"]);
  });

  it("keeps the cursor's own folder first when it was only partly done", () => {
    expect(entriesAfterCursor(sorted, { folder: "B", sub: "Book 2" }).map((x) => x.name)).toEqual([
      "B",
      "C 2",
      "C 10",
    ]);
  });

  it("returns nothing when the cursor is past the end", () => {
    expect(entriesAfterCursor(sorted, { folder: "Z" })).toEqual([]);
  });
});

describe("planScan", () => {
  it("manual and webhook scans always start over", () => {
    const lib = { scanIncomplete: true, scanCursor: { folder: "B" } };
    expect(planScan("manual", lib)).toEqual({ mode: "full" });
    expect(planScan("webhook", lib)).toEqual({ mode: "full" });
  });

  it("resume and cron continue from the cursor when incomplete", () => {
    const lib = { scanIncomplete: true, scanCursor: { folder: "B" } };
    expect(planScan("resume", lib)).toEqual({ mode: "continue", cursor: { folder: "B" } });
    expect(planScan("cron", lib)).toEqual({ mode: "continue", cursor: { folder: "B" } });
  });

  it("goes straight to probing when incomplete with no cursor", () => {
    expect(planScan("resume", { scanIncomplete: true, scanCursor: null })).toEqual({
      mode: "probe-only",
    });
  });

  it("starts a full scan when the last one completed", () => {
    expect(planScan("cron", { scanIncomplete: false, scanCursor: null })).toEqual({ mode: "full" });
    expect(planScan("resume", { scanIncomplete: false, scanCursor: null })).toEqual({ mode: "full" });
  });
});

describe("entriesAfterCursor with names that compare equal", () => {
  // "Season 01" and "Season 1" are equal to the comparator; only their ids tell them apart.
  const a = { id: "1", name: "Season 01" };
  const b = { id: "2", name: "Season 1" };
  const c = { id: "3", name: "Season 2" };

  it("doesn't skip the second of two equal-comparing folders when the pass stopped between them", () => {
    const sorted = sortForScan([c, b, a]);
    expect(sorted.map((e) => e.id)).toEqual(["1", "2", "3"]);
    const after = entriesAfterCursor(sorted, { folder: "Season 01", folderId: "1" });
    expect(after.map((e) => e.id)).toEqual(["2", "3"]);
  });

  it("re-includes the cursor's own folder when it was only partly done", () => {
    const sorted = sortForScan([a, b, c]);
    expect(entriesAfterCursor(sorted, { folder: "Season 1", folderId: "2", sub: "/x" }).map((e) => e.id)).toEqual(["2", "3"]);
  });

  it("behaves as before for cursors written without an id", () => {
    const sorted = sortForScan([a, b, c]);
    expect(entriesAfterCursor(sorted, { folder: "Season 01" }).map((e) => e.id)).toEqual(["3"]);
    expect(entriesAfterCursor(sorted, { folder: "Season 01", sub: "x" }).map((e) => e.id)).toEqual(["1", "2", "3"]);
  });
});
