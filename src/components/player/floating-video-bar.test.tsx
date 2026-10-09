import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { PlayerBarSpacer } from "./floating-video-bar";
import { VideoSessionProvider } from "./video-session";
import type { VideoSessionInfo } from "./video-session-state";

const session: VideoSessionInfo = { ownerKind: "episode", ownerId: "e1", title: "The <Show>", subtitle: "S1 · E2", backHref: "/s/x/show/s", watchHref: "/s/x/watch/episode/e1" };
// The provider draws the bar itself, only while the player is shrunk; the page below it holds the spacer.
const render = (initial: { session: VideoSessionInfo | null; expanded: boolean }) =>
  renderToStaticMarkup(
    <VideoSessionProvider initial={initial}>
      <PlayerBarSpacer />
    </VideoSessionProvider>
  );

describe("the floating video bar", () => {
  it("shows the title and the controls: step back, play, step forward, open the player, close", () => {
    const html = render({ session, expanded: false });
    expect(html).toContain('aria-label="Now playing"');
    expect(html).toContain("The &lt;Show&gt;");
    expect(html).not.toContain("The <Show>");
    for (const label of ["Back 10 seconds", "Forward 10 seconds", "Open the player", "Close the player"]) expect(html, label).toContain(`aria-label="${label}"`);
    expect(html).toMatch(/aria-label="Play"/);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("S1 · E2");
  });
  it("keeps the video itself mounted but out of sight while shrunk, and fills the screen with it when expanded", () => {
    const shrunk = render({ session, expanded: false });
    expect(shrunk).toContain("<video");
    expect(shrunk).toContain("size-px");
    expect(shrunk).toContain("inert");
    expect(shrunk).not.toContain("h-dvh");
    const full = render({ session, expanded: true });
    expect(full).toContain("<video");
    expect(full).toContain("h-dvh");
    expect(full).not.toContain("size-px");
    expect(full).toContain('class="fixed inset-0 z-50 bg-black"');
  });
  it("leaves room at the end of the page while it shows", () => {
    expect(render({ session, expanded: false })).toContain('class="h-24"');
  });
  it("is not there when nothing is open, and not there while the player fills the screen", () => {
    for (const state of [{ session: null, expanded: false }, { session, expanded: true }]) {
      const html = render(state);
      expect(html).not.toContain("Now playing");
      expect(html).not.toContain('class="h-24"');
    }
  });
});
