import { describe, expect, it } from "vitest";
import { groupByMonth, monthKey, monthLabel } from "./months";

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
