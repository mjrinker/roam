import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SubtitleOverlay, SubtitlePanel } from "./subtitles";

const tracks = [{ id: "a", label: "English", cues: [[0, 1, "x"] as [number, number, string]] }];
const noop = () => undefined;
const panel = (over: Partial<Parameters<typeof SubtitlePanel>[0]> = {}) =>
  renderToStaticMarkup(<SubtitlePanel ownerKind="title" ownerId="t" tracks={[]} activeId={null} onSelect={noop} onLoaded={noop} offset={0} onOffset={noop} onDone={noop} {...over} />);

describe("the subtitles panel", () => {
  it("offers Off, what has been loaded with the active one checked, and a way to load more", () => {
    const html = panel({ tracks, activeId: "a" });
    expect(html).toContain('aria-label="Subtitles"');
    expect(html).toMatch(/aria-checked="false"[^>]*>Off/);
    expect(html).toMatch(/aria-checked="true"[^>]*><span class="truncate">English/);
    expect(html).toContain("Find or load subtitles…");
  });
  it("shows the delay control only while a track is on", () => {
    expect(panel()).not.toContain("Subtitles earlier");
    expect(panel({ tracks, activeId: "a", offset: 0.5 })).toContain("+0.5s");
  });
});

describe("the words on the picture", () => {
  it("draws nothing before the first tick, so a bad cue can't put anything on screen by itself", () => {
    expect(renderToStaticMarkup(<SubtitleOverlay cues={[[0, 5, "<img src=x onerror=alert(1)>"]]} getTime={() => 1} offset={0} lifted={false} />)).toBe("");
  });
});
