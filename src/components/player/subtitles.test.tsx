import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SubtitleMenu, SubtitleOverlay } from "./subtitles";

const tracks = [{ id: "a", label: "English", cues: [[0, 1, "x"] as [number, number, string]] }];
const noop = () => undefined;
const menu = (over: Partial<Parameters<typeof SubtitleMenu>[0]> = {}) =>
  renderToStaticMarkup(<SubtitleMenu ownerKind="title" ownerId="t" tracks={[]} activeId={null} onSelect={noop} onLoaded={noop} offset={0} onOffset={noop} {...over} />);

describe("the subtitles button", () => {
  it("is always there (anyone can load subtitles), says whether they are on, and starts closed", () => {
    const off = menu();
    expect(off).toContain('aria-label="Subtitles, off"');
    expect(off).toContain('aria-haspopup="menu"');
    expect(off).toContain('aria-expanded="false"');
    expect(off).not.toContain('role="menu"');
    expect(menu({ tracks, activeId: "a" })).toContain('aria-label="Subtitles, on"');
  });
});

describe("the words on the picture", () => {
  it("draws nothing before the first tick, so a bad cue can't put anything on screen by itself", () => {
    expect(renderToStaticMarkup(<SubtitleOverlay cues={[[0, 5, "<img src=x onerror=alert(1)>"]]} getTime={() => 1} offset={0} lifted={false} />)).toBe("");
  });
});
