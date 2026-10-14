import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { PlayChoicesButton, PlayChoicesLink } from "./play-choices";

const lines = [{ category: "violence" as const, severity: "high" as const, scenes: 2, seconds: 30 }];

describe("play buttons", () => {
  it("are plain links to the player, ready to ask first when there is something to choose", () => {
    const button = renderToStaticMarkup(<PlayChoicesButton href="/s/1/watch/title/2" lines={lines} prefs={{}}>Play</PlayChoicesButton>);
    expect(button).toContain('href="/s/1/watch/title/2"');
    expect(button).toContain("Play");
    const link = renderToStaticMarkup(<PlayChoicesLink href="/s/1/watch/episode/3" lines={lines} prefs={{ violence: "high" }} className="row">An episode</PlayChoicesLink>);
    expect(link).toContain('href="/s/1/watch/episode/3"');
    expect(link).toContain('class="row"');
  });
  it("work without any scenes listed, and when the profile already skips everything", () => {
    expect(renderToStaticMarkup(<PlayChoicesButton href="/x" lines={[]} prefs={{}}>Play</PlayChoicesButton>)).toContain('href="/x"');
    expect(renderToStaticMarkup(<PlayChoicesLink href="/y" lines={lines} prefs={{ violence: "low" }}>Ep</PlayChoicesLink>)).toContain('href="/y"');
  });
});
