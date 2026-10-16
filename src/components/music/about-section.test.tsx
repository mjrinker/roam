import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AboutView, type AboutData } from "./about-section";

const base: AboutData = { found: true, summary: "A band from somewhere.", sourceTitle: "The Band", sourceUrl: "https://en.wikipedia.org/wiki/The_Band", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/" };

describe("AboutView", () => {
  it("shows the description with where it is from and its licence, both as links", () => {
    const html = renderToStaticMarkup(<AboutView serverId="s1" kind="artist" data={base} />);
    expect(html).toContain("About this artist");
    expect(html).toContain("A band from somewhere.");
    expect(html).toContain('href="https://en.wikipedia.org/wiki/The_Band"');
    expect(html).toContain("CC BY-SA 4.0");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("Read more"); // short enough to show whole
    expect(renderToStaticMarkup(<AboutView serverId="s1" kind="album" data={base} />)).toContain("About this album");
  });

  it("folds a long description behind Read more", () => {
    const html = renderToStaticMarkup(<AboutView serverId="s1" kind="artist" data={{ ...base, summary: "Word. ".repeat(100) }} />);
    expect(html).toContain("Read more");
    expect(html).toContain("line-clamp-4");
  });

  it("lists similar artists in the library as tiles and the others by name, crediting where they come from", () => {
    const html = renderToStaticMarkup(
      <AboutView serverId="s1" kind="artist" data={{ ...base, similarInLibrary: [{ id: "a1", name: "Friend", albumCount: 2, trackCount: 20, coverUrls: [] }], similarElsewhere: ["Stranger", "Another"] }} />
    );
    expect(html).toContain("Similar artists");
    expect(html).toContain('href="/s/s1/artist/a1"');
    expect(html).toContain("Friend");
    expect(html).toContain("Stranger, Another.");
    expect(html).toContain("Also similar, not in this library");
    expect(html).toContain("ListenBrainz");
  });

  it("draws nothing at all when nothing was found", () => {
    expect(renderToStaticMarkup(<AboutView serverId="s1" kind="artist" data={{ ...base, found: false, summary: null }} />)).toBe("");
    expect(renderToStaticMarkup(<AboutView serverId="s1" kind="artist" data={{ ...base, summary: null, similarInLibrary: [], similarElsewhere: [] }} />)).toBe("");
  });

  it("shows similar artists even without a description", () => {
    const html = renderToStaticMarkup(<AboutView serverId="s1" kind="artist" data={{ ...base, summary: null, sourceUrl: null, similarElsewhere: ["Only Names"] }} />);
    expect(html).not.toContain("About this artist");
    expect(html).toContain("Listeners also play: Only Names.");
  });
});
