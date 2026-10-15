import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LyricsView } from "./lyrics-panel";

const synced = { synced: [{ t: 1, text: "First line" }, { t: 5, text: "Second line" }, { t: 9, text: "" }], plain: "First line\nSecond line", instrumental: false };

describe("LyricsView", () => {
  it("shows each timed line as a button, with the one being sung marked", () => {
    const html = renderToStaticMarkup(<LyricsView lyrics={synced} current={1} onSeek={() => undefined} />);
    expect(html).toContain("Lyrics");
    expect(html).toContain("First line");
    expect(html).toContain("Second line");
    expect((html.match(/data-current/g) ?? []).length).toBe(1);
    expect(html.indexOf("data-current")).toBeGreaterThan(html.indexOf("First line"));
    expect(html.indexOf("data-current")).toBeLessThan(html.indexOf("Second line"));
    expect(html).toContain("Lyrics from LRCLIB");
  });
  it("marks none before the first line has started", () => {
    expect(renderToStaticMarkup(<LyricsView lyrics={synced} current={-1} onSeek={() => undefined} />)).not.toContain("data-current");
  });
  it("shows words alone as plain text, and an instrumental as one", () => {
    const plain = renderToStaticMarkup(<LyricsView lyrics={{ synced: null, plain: "Just\nwords", instrumental: false }} current={-1} onSeek={() => undefined} />);
    expect(plain).toContain("Just\nwords");
    expect(plain).not.toContain("<button");
    expect(renderToStaticMarkup(<LyricsView lyrics={{ synced: null, plain: null, instrumental: true }} current={-1} onSeek={() => undefined} />)).toContain("Instrumental");
  });
  it("escapes what the service sends", () => {
    const html = renderToStaticMarkup(<LyricsView lyrics={{ synced: [{ t: 1, text: "<img src=x onerror=alert(1)>" }], plain: null, instrumental: false }} current={0} onSeek={() => undefined} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
