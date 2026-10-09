import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { SubtitleMenu, SubtitleOverlay } from "./subtitles";

const tracks = [{ id: "a", language: "en", label: "English", hearingImpaired: false }, { id: "b", language: "es", label: "Español", hearingImpaired: false }];
const noop = () => undefined;

describe("the subtitles button", () => {
  it("says whether subtitles are on, and announces a menu, closed to begin with", () => {
    const off = renderToStaticMarkup(<SubtitleMenu tracks={tracks} activeId={null} onSelect={noop} offset={0} onOffset={noop} />);
    expect(off).toContain('aria-label="Subtitles, off"');
    expect(off).toContain('aria-haspopup="menu"');
    expect(off).toContain('aria-expanded="false"');
    expect(off).not.toContain('role="menu"');
    expect(renderToStaticMarkup(<SubtitleMenu tracks={tracks} activeId="a" onSelect={noop} offset={0} onOffset={noop} />)).toContain('aria-label="Subtitles, on"');
  });
  it("is not there when the video has no subtitles and nobody here can add any", () => {
    expect(renderToStaticMarkup(<SubtitleMenu tracks={[]} activeId={null} onSelect={noop} offset={0} onOffset={noop} />)).toBe("");
  });
  it("is there for someone who can add subtitles, even when there are none yet", () => {
    expect(renderToStaticMarkup(<SubtitleMenu tracks={[]} activeId={null} onSelect={noop} offset={0} onOffset={noop} manageHref="/s/x/subtitles/title/t" />)).toContain('aria-label="Subtitles, off"');
  });
});

describe("the words on the picture", () => {
  it("draws nothing before the first tick, so a bad cue can't put anything on screen by itself", () => {
    expect(renderToStaticMarkup(<SubtitleOverlay cues={[[0, 5, "<img src=x onerror=alert(1)>"]]} getTime={() => 1} offset={0} lifted={false} />)).toBe("");
  });
});
