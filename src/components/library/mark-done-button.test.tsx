import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }));

import { MarkDoneButton } from "./mark-done-button";

const render = (props: Partial<Parameters<typeof MarkDoneButton>[0]> & { done: boolean }) => renderToStaticMarkup(<MarkDoneButton kind="title" id="x" media="watch" {...props} />);

describe("MarkDoneButton", () => {
  it("offers the opposite of where things stand, in words that fit the media", () => {
    expect(render({ done: false })).toContain("Mark as watched");
    expect(render({ done: true })).toContain("Mark as unwatched");
    expect(render({ done: false, media: "listen" })).toContain("Mark as listened to");
    expect(render({ done: true, media: "listen" })).toContain("Mark as not listened to");
    expect(render({ done: false, media: "read" })).toContain("Mark as read");
    expect(render({ done: true, media: "read" })).toContain("Mark as unread");
  });
  it("names what a season or a show button covers", () => {
    expect(render({ kind: "season", scope: "season", done: false })).toContain("Mark season as watched");
    expect(render({ kind: "show", scope: "show", done: true })).toContain("Mark show as unwatched");
  });
  it("a compact icon has an accessible name", () => {
    const html = render({ done: false, variant: "icon", kind: "episode" });
    expect(html).toContain('aria-label="Mark as watched"');
  });
});
