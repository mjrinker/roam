import { describe, expect, it } from "vitest";
import { boxDate } from "./box-dates";

const NOW = Date.UTC(2026, 9, 5);

describe("boxDate", () => {
  it("accepts a Date, an SDK DateTime wrapper and an ISO string", () => {
    const d = new Date("2023-06-01T12:00:00Z");
    expect(boxDate(d, NOW)).toEqual(d);
    expect(boxDate({ value: d }, NOW)).toEqual(d);
    expect(boxDate("2023-06-01T12:00:00Z", NOW)).toEqual(d);
  });

  it("drops anything missing, malformed, the epoch, or in the future", () => {
    for (const bad of [undefined, null, 5, {}, { value: "x" }, "not a date", new Date("nope"), { value: new Date(NaN) }, new Date(0), new Date("1969-12-31T00:00:00Z"), new Date(NOW + 3 * 86_400_000)]) {
      expect(boxDate(bad, NOW), String(bad)).toBeUndefined();
    }
  });

  it("allows a date up to a day ahead (clock skew) and old but plausible dates", () => {
    expect(boxDate(new Date(NOW + 3600_000), NOW)).toBeDefined();
    expect(boxDate(new Date("1975-03-04T00:00:00Z"), NOW)).toBeDefined();
  });
});
