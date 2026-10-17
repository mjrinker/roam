import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RadioButton, radioUrl } from "./radio-button";

describe("RadioButton", () => {
  it("asks for a radio from an artist or from a song, escaping the id", () => {
    expect(radioUrl({ artistId: "a1" })).toBe("/api/music/radio?artist=a1");
    expect(radioUrl({ songId: "s 1&x" })).toBe("/api/music/radio?song=s%201%26x");
  });
  it("is a labelled button on a page and a compact icon in a song row", () => {
    expect(renderToStaticMarkup(<RadioButton seed={{ artistId: "a1" }} />)).toContain("Radio");
    const icon = renderToStaticMarkup(<RadioButton seed={{ songId: "s1" }} variant="icon" />);
    expect(icon).toContain('aria-label="Start radio from this song"');
  });
});
