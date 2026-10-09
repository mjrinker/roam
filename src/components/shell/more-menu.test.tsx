import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MoreMenu, placePanel } from "./more-menu";

describe("MoreMenu", () => {
  it("shows a More button that announces a popup, closed to begin with", () => {
    const html = renderToStaticMarkup(
      <MoreMenu>
        <button type="button">Resync</button>
      </MoreMenu>
    );
    expect(html).toContain(">More<");
    expect(html).toContain('aria-haspopup="true"');
    expect(html).toContain('aria-expanded="false"');
  });
  it("renders nothing when there is nothing in it (no empty More button)", () => {
    expect(renderToStaticMarkup(<MoreMenu>{false}{null}</MoreMenu>)).toBe("");
    expect(renderToStaticMarkup(<MoreMenu>{[]}</MoreMenu>)).toBe("");
  });
  it("can be labelled differently", () => {
    expect(renderToStaticMarkup(<MoreMenu label="Admin"><i /></MoreMenu>)).toContain(">Admin<");
  });
});

describe("placePanel", () => {
  it("opens under the button, aligned to its left edge", () => {
    expect(placePanel({ left: 100, bottom: 50, right: 180 }, { width: 1200 })).toEqual({ top: 58, left: 100 });
  });
  it("stays inside the window on the right and on the left", () => {
    expect(placePanel({ left: 1150, bottom: 50, right: 1190 }, { width: 1200 }).left).toBe(1200 - 240 - 8);
    expect(placePanel({ left: -30, bottom: 0, right: 10 }, { width: 1200 }).left).toBe(8);
    expect(placePanel({ left: 10, bottom: 0, right: 50 }, { width: 200 }).left).toBe(8); // a window narrower than the panel
  });
});
