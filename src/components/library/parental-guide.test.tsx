import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ParentalGuide } from "./parental-guide";

const lines = [
  { category: "violence" as const, severity: "high" as const, scenes: 3, seconds: 95 },
  { category: "language" as const, severity: "low" as const, scenes: 1, seconds: 4 },
];

describe("ParentalGuide", () => {
  it("lists each category with its strength, scenes and length", () => {
    const html = renderToStaticMarkup(<ParentalGuide lines={lines} prefs={{}} imdbId={null} />);
    expect(html).toContain("Violence");
    expect(html).toContain("Strong");
    expect(html).toContain("3 scenes");
    expect(html).toContain("2 min");
    expect(html).toContain("1 scene ·");
    expect(html).toContain("4 sec");
    expect(html).toContain("Mild");
  });
  it("marks the categories this profile skips, at its chosen strength and above", () => {
    const html = renderToStaticMarkup(<ParentalGuide lines={lines} prefs={{ violence: "high", language: "medium" }} imdbId={null} />);
    expect(html.match(/skipped for you/g)).toHaveLength(1); // violence is strong enough; the mild language is below the profile's threshold
  });
  it("links the IMDb parents guide when there is an IMDb id, even with nothing from a file", () => {
    const html = renderToStaticMarkup(<ParentalGuide lines={[]} prefs={{}} imdbId="tt0133093" />);
    expect(html).toContain('href="https://www.imdb.com/title/tt0133093/parentalguide"');
    expect(html).not.toContain("From a content filter file");
  });
  it("shows nothing when there is nothing to say", () => {
    expect(renderToStaticMarkup(<ParentalGuide lines={[]} prefs={{}} imdbId={null} />)).toBe("");
  });
});
