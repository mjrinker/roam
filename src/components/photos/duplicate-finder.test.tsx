import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DuplicateFinder } from "./duplicate-finder";

describe("DuplicateFinder", () => {
  it("opens loading, with the way to check photos and the choices of how alike", () => {
    const html = renderToStaticMarkup(<DuplicateFinder libraryId="lib1" />);
    expect(html).toContain("Loading…");
    expect(html).toContain("Check photos");
    for (const word of ["Identical", "Look the same", "Alike"]) expect(html).toContain(word);
    expect(html).toContain("Nothing is downloaded in full".replace("Nothing", "nothing"));
    expect(html).toContain("only leaves it out of the timeline");
  });
});
