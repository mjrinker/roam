import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DayBars } from "./bar-chart";

describe("DayBars", () => {
  it("draws a bar per day with its date and time, scaled to the busiest, and says the busiest", () => {
    const html = renderToStaticMarkup(<DayBars days={[{ day: "2026-10-15", seconds: 0 }, { day: "2026-10-16", seconds: 1800 }, { day: "2026-10-17", seconds: 3600 }]} />);
    expect(html).toContain("Oct 16: 30m");
    expect(html).toContain("Oct 17: 1h");
    expect(html).toContain("height:100%");
    expect(html).toContain("height:50%");
    expect(html).toContain("Busiest day: 1h");
    expect(html).toContain("1h 30m over 3 days");
  });
  it("copes with a quiet stretch", () => {
    const html = renderToStaticMarkup(<DayBars days={[{ day: "2026-10-16", seconds: 0 }]} />);
    expect(html).toContain("Busiest day: 0m");
    expect(html).toContain("height:0%");
    expect(renderToStaticMarkup(<DayBars days={[]} />)).toContain("0m over 0 days");
  });
});
