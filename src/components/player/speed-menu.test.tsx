import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SpeedMenu, SpeedPanel } from "./speed-menu";

const noop = () => undefined;

describe("the speed controls", () => {
  it("show the current speed on the button, and name it for screen readers", () => {
    for (const [rate, text] of [[1, "1x"], [1.25, "1.25x"], [0.25, "0.25x"], [3, "3x"], [1.35, "1.35x"]] as const) {
      const html = renderToStaticMarkup(<SpeedMenu rate={rate} onChange={noop} />);
      expect(html).toContain(`>${text}<`);
      expect(html).toContain(`aria-label="Playback speed, ${text}"`);
    }
  });
  it("list every step in the panel with the current one checked, a custom box, and the make-default row when a library is known", () => {
    const html = renderToStaticMarkup(<SpeedPanel rate={1.5} onChange={noop} onDone={noop} defaultSpeed={{ libraryId: "l", saved: null }} />);
    expect(html).toContain('role="menu"');
    expect(html).toMatch(/aria-checked="true"[^>]*>1\.5x/);
    expect(html).toContain('aria-label="Custom speed"');
    expect(html).toContain("Make 1.5x my default here");
    expect(renderToStaticMarkup(<SpeedPanel rate={1.5} onChange={noop} onDone={noop} />)).not.toContain("my default");
  });
});
