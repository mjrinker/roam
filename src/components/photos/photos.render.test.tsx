import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { PhotoTile, photoHref } from "./photo-tile";
import { PhotoTimeline } from "./photo-timeline";
import { PhotoViewer } from "./photo-viewer";
import type { TimelineItem } from "@/lib/photos/timeline";

const item = (over: Partial<TimelineItem> = {}): TimelineItem => ({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "photo",
  name: "IMG 0042",
  takenAt: "2024-03-30T10:00:00.000Z",
  width: 4000,
  height: 3000,
  posterUrl: "/api/photos/11111111-1111-4111-8111-111111111111/thumb?v=1ab-2cd",
  runtimeSeconds: null,
  ...over,
});

describe("PhotoTile", () => {
  it("opens a picture in the viewer (remembering where you came from) and plays a video in the player", () => {
    expect(photoHref("srv", { id: "p", kind: "photo" }, "from=timeline")).toBe("/s/srv/photo/p?from=timeline");
    expect(photoHref("srv", { id: "v", kind: "movie" }, "from=timeline")).toBe("/s/srv/watch/title/v");
  });

  it("draws the thumbnail straight from Roam's private route (never through the shared image optimizer), with a descriptive link", () => {
    const html = renderToStaticMarkup(<PhotoTile serverId="srv" item={item()} from="from=timeline" />);
    expect(html).toContain('src="/api/photos/11111111-1111-4111-8111-111111111111/thumb?v=1ab-2cd"');
    expect(html).not.toContain("/_next/image");
    expect(html).toContain('aria-label="Open photo IMG 0042"');
    expect(html).toContain('href="/s/srv/photo/11111111-1111-4111-8111-111111111111?from=timeline"');
    expect(html).toContain('alt=""'); // the link carries the label; the image is decoration
  });

  it("marks a video with its length, and a tile without a thumbnail shows a placeholder, not a broken image", () => {
    const video = renderToStaticMarkup(<PhotoTile serverId="srv" item={item({ kind: "movie", runtimeSeconds: 125, name: "Clip" })} from="from=timeline" />);
    expect(video).toContain("2:05");
    expect(video).toContain('aria-label="Play video Clip"');
    const long = renderToStaticMarkup(<PhotoTile serverId="srv" item={item({ kind: "movie", runtimeSeconds: 3725 })} from="from=timeline" />);
    expect(long).toContain("1:02:05");
    const none = renderToStaticMarkup(<PhotoTile serverId="srv" item={item({ posterUrl: null })} from="from=timeline" />);
    expect(none).not.toContain("<img");
  });
});

describe("PhotoTimeline", () => {
  const props = { serverId: "srv", libraryId: "lib" };

  it("groups tiles under month headings, newest first, and says when that is everything", () => {
    const html = renderToStaticMarkup(
      <PhotoTimeline {...props} initialNext={null} initialItems={[item({ id: "a", takenAt: "2024-03-30T00:00:00Z" }), item({ id: "b", takenAt: "2024-03-02T00:00:00Z" }), item({ id: "c", takenAt: "2023-12-31T23:59:00Z" })]} />
    );
    expect(html.indexOf("March 2024")).toBeLessThan(html.indexOf("December 2023"));
    expect(html.match(/March 2024/g)).toHaveLength(2); // the heading and its section's aria-label
    expect(html).toContain("That&#x27;s everything.");
  });

  it("keeps loading while there is a next page, and shows a friendly empty state for an empty library", () => {
    const more = renderToStaticMarkup(<PhotoTimeline {...props} initialNext="cursor" initialItems={[item()]} />);
    expect(more).not.toContain("everything");
    const empty = renderToStaticMarkup(<PhotoTimeline {...props} initialNext={null} initialItems={[]} />);
    expect(empty).toContain("No photos yet");
  });
});

describe("PhotoViewer", () => {
  const base = { previewUrl: "/api/photos/p/preview", originalUrl: "/api/photos/p/original", name: "Beach", takenLabel: "March 30, 2024 at 10:00 AM", dimensions: "4000 × 3000", backHref: "/s/srv/library/lib", nextPreviewUrl: null };

  it("shows the preview, the details and a download link, with a way to step in each direction that exists", () => {
    const html = renderToStaticMarkup(<PhotoViewer {...base} prevHref="/s/srv/photo/new?from=timeline" nextHref="/s/srv/photo/old?from=timeline" />);
    expect(html).toContain('src="/api/photos/p/preview"');
    expect(html).not.toContain("/_next/image");
    expect(html).toContain("Beach");
    expect(html).toContain("March 30, 2024 at 10:00 AM · 4000 × 3000");
    expect(html).toContain('href="/api/photos/p/original"');
    expect(html).toContain("Download original");
    expect(html).toContain('aria-label="Previous photo"');
    expect(html).toContain('aria-label="Next photo"');
    expect(html).toContain('aria-label="Back to the library"');
  });

  it("offers no step past the first or last photo", () => {
    const first = renderToStaticMarkup(<PhotoViewer {...base} prevHref={null} nextHref="/s/srv/photo/old?from=timeline" />);
    expect(first).not.toContain("Previous photo");
    expect(first).toContain("Next photo");
    const last = renderToStaticMarkup(<PhotoViewer {...base} prevHref="/s/srv/photo/new?from=timeline" nextHref={null} />);
    expect(last).toContain("Previous photo");
    expect(last).not.toContain("Next photo");
  });
});
