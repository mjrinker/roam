import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CrossfadeSetting } from "./crossfade-setting";

describe("CrossfadeSetting", () => {
  it("offers Off and each length, marking the one chosen, and says what it does", () => {
    const html = renderToStaticMarkup(<CrossfadeSetting value={6} onChange={() => {}} canOverlap />);
    for (const label of ["Off", "2 s", "4 s", "6 s", "8 s", "10 s", "12 s"]) expect(html).toContain(label);
    expect(html).toContain("Crossfade · 6 s");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain("also fades one into the next");
  });
  it("shows nothing about a length when off, and is honest on a device that can't overlap songs", () => {
    const off = renderToStaticMarkup(<CrossfadeSetting value={0} onChange={() => {}} canOverlap />);
    expect(off).not.toContain(" s</h3>");
    const iphone = renderToStaticMarkup(<CrossfadeSetting value={8} onChange={() => {}} canOverlap={false} />);
    expect(iphone).toContain("can&#x27;t overlap them");
    expect(iphone).not.toContain("Crossfade · 8 s");
  });
});
