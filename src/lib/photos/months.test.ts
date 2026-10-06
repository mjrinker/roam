import { describe, expect, it } from "vitest";
import { canScrollInPlace, bucketAt, bucketLabel, groupByMonth, groupItems, groupKey, groupLabel, monthKey, monthLabel, scrubberMarks } from "./months";

describe("month grouping", () => {
  it("reads the month in UTC, so a photo taken at 23:50 on the 31st stays in that month", () => {
    expect(monthKey("2024-01-31T23:50:00.000Z")).toBe("2024-01");
    expect(monthKey("2024-02-01T00:00:00.000Z")).toBe("2024-02");
    expect(monthLabel("2024-01-31T23:50:00.000Z")).toBe("January 2024");
    expect(monthLabel("2024-12-01T00:00:00.000Z")).toBe("December 2024");
  });

  it("calls anything undated or unreadable 'Undated'", () => {
    for (const bad of [null, "", "not a date"]) {
      expect(monthKey(bad)).toBe("undated");
      expect(monthLabel(bad)).toBe("Undated");
    }
  });

  it("groups consecutive items, treats a month split across pages as one group, and keeps a returning month separate", () => {
    const item = (id: string, takenAt: string | null) => ({ id, takenAt });
    const groups = groupByMonth([
      item("a", "2024-03-30T00:00:00Z"),
      item("b", "2024-03-02T00:00:00Z"),
      item("c", "2024-02-10T00:00:00Z"),
      item("d", "2024-03-01T00:00:00Z"), // out of order input: a new group, never merged backwards
      item("e", null),
      item("f", null),
    ]);
    expect(groups.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ["2024-03", ["a", "b"]],
      ["2024-02", ["c"]],
      ["2024-03", ["d"]],
      ["undated", ["e", "f"]],
    ]);
    expect(groups[0].label).toBe("March 2024");
  });

  it("returns nothing for nothing", () => {
    expect(groupByMonth([])).toEqual([]);
  });
});

describe("zoom levels", () => {
  it("keys and labels the same moment as a day, a month or a year", () => {
    const t = "2024-03-30T23:50:00.000Z";
    expect([groupKey(t, "day"), groupKey(t, "month"), groupKey(t, "year")]).toEqual(["2024-03-30", "2024-03", "2024"]);
    expect(groupLabel(t, "day")).toBe("Saturday, March 30, 2024");
    expect(groupLabel(t, "year")).toBe("2024");
    expect(groupKey(null, "day")).toBe("undated");
    expect(groupLabel("nope", "year")).toBe("Undated");
  });
  it("a late-night photo stays on its own day in UTC", () => {
    expect(groupKey("2024-03-31T23:59:59.000Z", "day")).toBe("2024-03-31");
    expect(groupKey("2024-04-01T00:00:00.000Z", "day")).toBe("2024-04-01");
  });
  it("groups by the chosen level", () => {
    const items = ["2024-03-30T10:00:00Z", "2024-03-30T08:00:00Z", "2024-03-02T08:00:00Z", "2023-12-31T08:00:00Z", null].map((takenAt, i) => ({ id: String(i), takenAt }));
    expect(groupItems(items, "day").map((g) => [g.key, g.items.length])).toEqual([["2024-03-30", 2], ["2024-03-02", 1], ["2023-12-31", 1], ["undated", 1]]);
    expect(groupItems(items, "month").map((g) => g.key)).toEqual(["2024-03", "2023-12", "undated"]);
    expect(groupItems(items, "year").map((g) => [g.key, g.items.length])).toEqual([["2024", 3], ["2023", 1], ["undated", 1]]);
  });
});

describe("scrubber", () => {
  it("labels a year where it begins and drops labels that would crowd the previous one", () => {
    const keys = ["2024-03", "2024-02", "2023-12", "2023-11", "undated"];
    expect(scrubberMarks(keys, 0.1).map((m) => m.year)).toEqual(["2024", null, "2023", null, null]);
    const many = Array.from({ length: 36 }, (_, i) => `${2024 - Math.floor(i / 12)}-${String(12 - (i % 12)).padStart(2, "0")}`);
    expect(scrubberMarks(many).filter((m) => m.year).map((m) => m.year)).toEqual(["2024", "2023", "2022"]);
    const crowded = Array.from({ length: 30 }, (_, i) => `${2024 - i}-06`);
    const labelled = scrubberMarks(crowded).filter((m) => m.year);
    expect(labelled.length).toBeLessThan(30);
    for (let i = 1; i < labelled.length; i++) expect(labelled[i].at - labelled[i - 1].at).toBeGreaterThanOrEqual(0.045);
  });
  it("spreads buckets evenly from 0 to 1, and copes with one or none", () => {
    expect(scrubberMarks(["2024-03", "2024-02", "2024-01"]).map((m) => m.at)).toEqual([0, 0.5, 1]);
    expect(scrubberMarks(["2024-03"]).map((m) => m.at)).toEqual([0]);
    expect(scrubberMarks([])).toEqual([]);
  });
  it("maps a position on the rail to a bucket, clamped to the ends", () => {
    expect(bucketAt(0, 4)).toBe(0);
    expect(bucketAt(0.26, 4)).toBe(1);
    expect(bucketAt(0.99, 4)).toBe(3);
    expect(bucketAt(1, 4)).toBe(3);
    expect(bucketAt(-3, 4)).toBe(0);
    expect(bucketAt(7, 4)).toBe(3);
    expect(bucketAt(0.5, 0)).toBe(-1);
  });
  it("names buckets for the floating label", () => {
    expect(bucketLabel("2024-03")).toBe("March 2024");
    expect(bucketLabel("undated")).toBe("Undated");
    expect(bucketLabel("weird")).toBe("weird");
  });
});

describe("canScrollInPlace", () => {
  const at = (...t: string[]) => t.map((takenAt) => ({ takenAt }));
  // After jumping to July the run is July, June, May; newer photos are still above (hasNewerToLoad).
  const july = at("2024-07-20T00:00:00Z", "2024-07-02T00:00:00Z", "2024-06-10T00:00:00Z", "2024-05-01T00:00:00Z");

  it("a month deeper in the run is complete from its newest photo, so it scrolls in place", () => {
    expect(canScrollInPlace(july, true, "2024-06")).toBe(true);
    expect(canScrollInPlace(july, true, "2024-05")).toBe(true);
  });
  it("the month that starts the run while newer photos are still to load would show partly, so it loads afresh", () => {
    expect(canScrollInPlace(july, true, "2024-07")).toBe(false);
  });
  it("...but once the top of the library is loaded, it is complete", () => {
    expect(canScrollInPlace(july, false, "2024-07")).toBe(true);
  });
  it("a month with nothing loaded always loads afresh (August after scrubbing to July)", () => {
    expect(canScrollInPlace(july, true, "2024-08")).toBe(false);
    expect(canScrollInPlace(july, false, "2024-08")).toBe(false);
    expect(canScrollInPlace([], false, "2024-07")).toBe(false);
  });
  it("after scrolling up and loading newer pages, the months now above are complete", () => {
    const more = [...at("2024-09-03T00:00:00Z", "2024-08-15T00:00:00Z", "2024-08-01T00:00:00Z"), ...july];
    expect(canScrollInPlace(more, true, "2024-08")).toBe(true);
    expect(canScrollInPlace(more, true, "2024-09")).toBe(false); // starts the run, more may be above
    expect(canScrollInPlace(more, false, "2024-09")).toBe(true);
  });
});
