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
