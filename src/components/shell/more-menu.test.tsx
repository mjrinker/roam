import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MoreMenu, placePanel } from "./more-menu";

describe("MoreMenu", () => {
  it("is just an ellipsis button, with an accessible name and no visible text, that announces a popup and starts closed", () => {
    const html = renderToStaticMarkup(
      <MoreMenu>
        <button type="button">Resync</button>
      </MoreMenu>
    );
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('aria-haspopup="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("<svg");
    expect(html).not.toMatch(/>More</);
  });
  it("renders nothing when there is nothing in it (no empty button)", () => {
    expect(renderToStaticMarkup(<MoreMenu>{false}{null}</MoreMenu>)).toBe("");
    expect(renderToStaticMarkup(<MoreMenu>{[]}</MoreMenu>)).toBe("");
  });
  it("can be named differently for screen readers", () => {
    expect(renderToStaticMarkup(<MoreMenu label="Admin tools"><i /></MoreMenu>)).toContain('aria-label="Admin tools"');
  });
});

describe("placePanel", () => {
  const view = { width: 1200, height: 800 };
  it("opens under the button when it fits, aligned to its left edge", () => {
    expect(placePanel({ left: 100, top: 20, bottom: 60 }, view, { width: 240, height: 200 })).toEqual({ top: 68, left: 100 });
  });
  it("flips above the button when it would run off the bottom of the screen", () => {
    // a button near the bottom: 200px of room above is not needed, 700px is; the panel is 160 tall
    expect(placePanel({ left: 100, top: 700, bottom: 740 }, view, { width: 240, height: 160 })).toEqual({ top: 700 - 8 - 160, left: 100 });
  });
  it("scrolls inside the room it has when it fits neither above nor below", () => {
    const tall = placePanel({ left: 100, top: 400, bottom: 440 }, view, { width: 240, height: 900 });
    expect(tall.maxHeight).toBeDefined();
    expect(tall.top + (tall.maxHeight ?? 0)).toBeLessThanOrEqual(view.height);
    expect(tall.top).toBeGreaterThanOrEqual(8);
    // more room above: it sits at the top of the window and scrolls; more room below: it hangs from the button
    expect(placePanel({ left: 0, top: 600, bottom: 640 }, view, { width: 240, height: 900 }).top).toBe(8);
    expect(placePanel({ left: 0, top: 100, bottom: 140 }, view, { width: 240, height: 900 }).top).toBe(148);
  });
  it("stays inside the window on the right and on the left, even in a window narrower than the panel", () => {
    expect(placePanel({ left: 1150, top: 0, bottom: 40 }, view, { width: 240, height: 100 }).left).toBe(1200 - 240 - 8);
    expect(placePanel({ left: -30, top: 0, bottom: 40 }, view, { width: 240, height: 100 }).left).toBe(8);
    expect(placePanel({ left: 10, top: 0, bottom: 40 }, { width: 200, height: 800 }, { width: 240, height: 100 }).left).toBe(8);
  });
});
