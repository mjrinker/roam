import { describe, expect, it } from "vitest";
import { blockHeight, bucketRange, gridColumns, HEADING_GAP, HEADING_HEIGHT, tileSize, TILE_GAP, bucketAt, bucketLabel, groupByMonth, groupItems, groupKey, groupLabel, monthKey, monthLabel, scrubberMarks } from "./months";

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

describe("bucketRange", () => {
  const r = (level: "day" | "month" | "year", key: string) => {
    const x = bucketRange(level, key);
    return x ? [x.from.toISOString().slice(0, 10), x.to.toISOString().slice(0, 10)] : null;
  };
  it("is the UTC period a key stands for", () => {
    expect(r("year", "2024")).toEqual(["2024-01-01", "2025-01-01"]);
    expect(r("month", "2024-12")).toEqual(["2024-12-01", "2025-01-01"]);
    expect(r("day", "2024-02-29")).toEqual(["2024-02-29", "2024-03-01"]);
  });
  it("is null for a key of another level, an impossible date, undated, or junk", () => {
    for (const [level, key] of [["year", "2024-03"], ["month", "2024"], ["month", "2024-13"], ["month", "2024-00"], ["day", "2023-02-29"], ["day", "2024-04-31"], ["day", "2024-03-00"], ["month", "undated"], ["year", "0000"], ["year", "99999"], ["day", "x"], ["month", "'; --"]] as const) {
      expect(r(level, key), `${level} ${key}`).toBeNull();
    }
  });
});

describe("laying blocks out up front", () => {
  it("picks the columns the grid classes pick, at each width and level", () => {
    expect([gridColumns("month", 390), gridColumns("month", 640), gridColumns("month", 768), gridColumns("month", 1024), gridColumns("month", 1280)]).toEqual([3, 4, 5, 6, 8]);
    expect([gridColumns("day", 390), gridColumns("day", 1280)]).toEqual([3, 6]);
    expect([gridColumns("year", 390), gridColumns("year", 639), gridColumns("year", 1500)]).toEqual([5, 5, 14]);
  });
  it("a tile is the width left after the gaps, split evenly", () => {
    expect(tileSize(400, 4)).toBe((400 - 3 * TILE_GAP) / 4);
    expect(tileSize(0, 3)).toBe(0);
  });
  it("a block's height is its heading plus its rows of square tiles and the gaps between them", () => {
    const tile = tileSize(400, 4); // 97
    expect(blockHeight(8, 4, 400)).toBe(Math.round(HEADING_HEIGHT + HEADING_GAP + 2 * tile + TILE_GAP));
    expect(blockHeight(9, 4, 400)).toBe(Math.round(HEADING_HEIGHT + HEADING_GAP + 3 * tile + 2 * TILE_GAP));
    expect(blockHeight(1, 4, 400)).toBe(Math.round(HEADING_HEIGHT + HEADING_GAP + tile));
  });
  it("an empty block is just its heading, and a negative count is treated as empty", () => {
    expect(blockHeight(0, 4, 400)).toBe(HEADING_HEIGHT + HEADING_GAP);
    expect(blockHeight(-5, 4, 400)).toBe(HEADING_HEIGHT + HEADING_GAP);
  });
  it("more photos never make a block shorter", () => {
    let last = 0;
    for (let n = 0; n <= 50; n++) {
      const h = blockHeight(n, 5, 600);
      expect(h).toBeGreaterThanOrEqual(last);
      last = h;
    }
  });
});
