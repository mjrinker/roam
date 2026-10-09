import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineSpeedMenu, SpeedMenu } from "./speed-menu";

describe("the speed controls", () => {
  it("show the current speed on the button, and name it for screen readers", () => {
    for (const [rate, text] of [[1, "1x"], [1.25, "1.25x"], [0.25, "0.25x"], [3, "3x"], [1.35, "1.35x"]] as const) {
      const inline = renderToStaticMarkup(<InlineSpeedMenu rate={rate} onChange={() => undefined} />);
      expect(inline).toContain(`>${text}<`);
      expect(inline).toContain(`aria-label="Playback speed, ${text}"`);
      expect(renderToStaticMarkup(<SpeedMenu rate={rate} onChange={() => undefined} />)).toContain(`>${text}<`);
    }
  });
  it("start closed, announcing a menu", () => {
    const html = renderToStaticMarkup(<InlineSpeedMenu rate={1} onChange={() => undefined} />);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });
});
