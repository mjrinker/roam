import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { FavoriteButton } from "./favorite-button";
import { PhotoTile, photoHref } from "./photo-tile";
import { PhotoTimeline } from "./photo-timeline";
import { PhotoViewer } from "./photo-viewer";
import type { TimelineItem } from "@/lib/photos/timeline";
import type { ViewerItem } from "@/lib/photos/viewer-item";

const item = (over: Partial<TimelineItem> = {}): TimelineItem => ({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "photo",
  name: "IMG 0042",
  takenAt: "2024-03-30T10:00:00.000Z",
  width: 4000,
  height: 3000,
  posterUrl: "/api/photos/11111111-1111-4111-8111-111111111111/thumb?v=1ab-2cd",
  runtimeSeconds: null,
  favorite: false,
  filename: "IMG_0042.JPG",
  sizeBytes: 3_453_641,
  container: "jpg",
  folderPath: "Trip",
  ...over,
});

describe("PhotoTile", () => {
  it("opens pictures and videos in the same viewer (remembering where you came from)", () => {
    expect(photoHref("srv", { id: "p", kind: "photo" }, "from=timeline")).toBe("/s/srv/photo/p?from=timeline");
    expect(photoHref("srv", { id: "v", kind: "movie" }, "from=timeline")).toBe("/s/srv/photo/v?from=timeline");
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

const W = { add: "Add to favorites", remove: "Remove from favorites" };
const timeline = (props: Partial<React.ComponentProps<typeof PhotoTimeline>> & { items?: TimelineItem[] }) => {
  const items = props.items ?? [];
  const counts = new Map<string, number>();
  for (const i of items) counts.set((i.takenAt ?? "undated").slice(0, 7), (counts.get((i.takenAt ?? "undated").slice(0, 7)) ?? 0) + 1);
  const buckets = [...counts].map(([key, count]) => ({ key, count }));
  return renderToStaticMarkup(<PhotoTimeline serverId="srv" libraryId="lib" words={W} initialItems={items} initialBuckets={buckets} {...props} />);
};

describe("PhotoTimeline", () => {
  it("draws the photos it was given under month headings, newest first", () => {
    const html = timeline({ items: [item({ id: "a", takenAt: "2024-03-30T00:00:00Z" }), item({ id: "b", takenAt: "2024-03-02T00:00:00Z" }), item({ id: "c", takenAt: "2023-12-31T23:59:00Z" })] });
    expect(html.indexOf("March 2024")).toBeLessThan(html.indexOf("December 2023"));
    expect(html.match(/<h2/g)).toHaveLength(2);
    expect(html.match(/<li[ >]/g)).toHaveLength(3); // (not the preload <link> tags)
    expect(html).toContain('data-bucket="2024-03"');
  });

  it("only draws a block that already has photos before it has been measured (the server's render); the rest wait for the browser", () => {
    const html = renderToStaticMarkup(
      <PhotoTimeline serverId="srv" libraryId="lib" words={W} initialItems={[item()]} initialBuckets={[{ key: "2024-03", count: 1 }, { key: "2023-01", count: 400 }, { key: "2020-07", count: 12 }]} />
    );
    expect(html).toContain('data-bucket="2024-03"');
    expect(html).not.toContain('data-bucket="2023-01"');
    expect(html).not.toContain('data-bucket="2020-07"');
  });

  it("shows a friendly empty state for an empty library", () => {
    const html = timeline({ items: [] });
    expect(html).toContain("No photos yet");
    expect(html).not.toContain('role="group"'); // no zoom control with nothing to zoom
  });
});

describe("favorites in the interface", () => {
  it("a tile shows a heart only when it is a favorite", () => {
    expect(renderToStaticMarkup(<PhotoTile serverId="srv" item={item()} from="from=timeline" />)).not.toContain("fill-rose-500");
    expect(renderToStaticMarkup(<PhotoTile serverId="srv" item={{ ...item(), favorite: true }} from="from=timeline" />)).toContain("fill-rose-500");
  });

  it("a favorites timeline links tiles with where they came from and speaks in the profile's spelling", () => {
    expect(timeline({ view: "favorites", items: [item()] })).toContain("?from=favorites");
    expect(timeline({ view: "favorites", items: [], emptyTitle: "No favourites yet", emptyHint: "Tap the heart…" })).toContain("No favourites yet");
  });

  it("the heart button reads as pressed when set and offers the right action", () => {
    const off = renderToStaticMarkup(<FavoriteButton id="p" libraryId="l" initial={false} addLabel="Add to favorites" removeLabel="Remove from favorites" />);
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('aria-label="Add to favorites"');
    const on = renderToStaticMarkup(<FavoriteButton id="p" libraryId="l" initial addLabel="Add to favorites" removeLabel="Remove from favorites" />);
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('aria-label="Remove from favorites"');
  });
});

describe("timeline zoom and search copy", () => {
  it("offers days, months and years, starting at months, with the other levels one tap away", () => {
    const html = timeline({ items: [item({ id: "a", takenAt: "2024-03-30T10:00:00Z" })] });
    expect(html).toContain('aria-label="Zoom"');
    for (const label of ["Days", "Months", "Years"]) expect(html).toContain(label);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("March 2024");
  });

  it("an empty search says so and suggests what to try, instead of 'no photos yet'", () => {
    const html = timeline({ items: [], q: "zzz" });
    expect(html).toContain("Nothing matches");
    expect(html).toContain("zzz");
    expect(html).not.toContain("No photos yet");
  });
});

describe("the month scrubber", () => {
  const timelineWithMonths = () =>
    renderToStaticMarkup(
      <PhotoTimeline serverId="srv" libraryId="lib" words={W} initialItems={[item()]} initialBuckets={[{ key: "2024-03", count: 1 }, { key: "2024-02", count: 4 }, { key: "2023-12", count: 2 }]} />
    );
  it("is a slider on the right edge that the pull-down-to-refresh is told to leave alone", () => {
    const html = timelineWithMonths();
    const rail = html.match(/<div[^>]*role="slider"[^>]*>/)![0];
    expect(rail).toContain("data-no-pull");
    expect(rail).toContain("touch-none");
    expect(rail).toContain('aria-label="Jump to a month"');
  });
  it("is absent when there is only one month to move between", () => {
    const html = renderToStaticMarkup(<PhotoTimeline serverId="srv" libraryId="lib" words={W} initialItems={[item()]} initialBuckets={[{ key: "2024-03", count: 1 }]} />);
    expect(html).not.toContain('role="slider"');
  });
});

describe("PhotoViewer", () => {
  const mk = (id: string, over: Partial<ViewerItem> = {}): ViewerItem => ({
    id,
    kind: "photo",
    name: `Photo ${id}`,
    thumbUrl: `/api/photos/${id}/thumb?v=1`,
    previewUrl: `/api/photos/${id}/preview`,
    originalUrl: `/api/photos/${id}/original`,
    zoomOriginal: true,
    details: [["Taken", "March 30, 2024 at 10:00 AM"], ["Size", "4000 × 3000"]],
    favorite: false,
    ...over,
  });
  const noop = () => undefined;
  const base = { onPrev: noop, onNext: noop, onClose: noop, libraryId: "lib", words: { add: "Add to favorites", remove: "Remove from favorites" } };

  it("shows the thumbnail and the preview, the date, a download link and the controls, as a dialog over the page", () => {
    const html = renderToStaticMarkup(<PhotoViewer {...base} current={mk("p")} prev={mk("a")} next={mk("b")} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('src="/api/photos/p/thumb?v=1"'); // at once: already cached from the grid
    expect(html).toContain('src="/api/photos/p/preview"');
    expect(html).not.toContain("/_next/image");
    expect(html).toContain("March 30, 2024 at 10:00 AM");
    expect(html).toContain('href="/api/photos/p/original"');
    for (const label of ["Download original", "Info", "Previous", "Next", "Back to the library", "Add to favorites"]) expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain('aria-label="Details"'); // the panel starts closed
  });

  it("puts the neighbours' thumbnails beside the current item, ready to slide in, but not their full previews", () => {
    const html = renderToStaticMarkup(<PhotoViewer {...base} current={mk("p")} prev={mk("a")} next={mk("b")} />);
    expect(html).toContain('src="/api/photos/a/thumb?v=1"');
    expect(html).toContain('src="/api/photos/b/thumb?v=1"');
    expect(html).not.toContain("/api/photos/a/preview");
    expect(html).not.toContain("/api/photos/b/preview");
  });

  it("neighbours are moved by a transform and keep one frame's width, never stretched across the screen behind the current photo", () => {
    const html = renderToStaticMarkup(<PhotoViewer {...base} current={mk("p")} prev={mk("a")} next={mk("b")} />);
    expect(html).toContain("translateX(-100%)");
    expect(html).toContain("translateX(100%)");
    expect(html).not.toMatch(/style="[^"]*left:\s*-?100%/);
  });

  it("offers no step past the first or last item", () => {
    const first = renderToStaticMarkup(<PhotoViewer {...base} current={mk("p")} prev={null} next={mk("b")} />);
    expect(first).not.toContain('aria-label="Previous"');
    expect(first).toContain('aria-label="Next"');
    const last = renderToStaticMarkup(<PhotoViewer {...base} current={mk("p")} prev={mk("a")} next={null} />);
    expect(last).toContain('aria-label="Previous"');
    expect(last).not.toContain('aria-label="Next"');
  });

  it("a video shows its poster with a play button (it never starts by itself) and no picture preview", () => {
    const html = renderToStaticMarkup(<PhotoViewer {...base} current={mk("v", { kind: "movie", name: "Clip" })} prev={mk("c", { kind: "movie" })} next={null} />);
    expect(html).toContain('aria-label="Play video Clip"');
    expect(html).toContain('src="/api/photos/v/thumb?v=1"');
    expect(html).not.toContain("/api/photos/v/preview");
    expect(html).not.toContain("<video");
  });

  it("only the round play button is a button, so swiping over the rest of a video's poster steps like any photo", () => {
    const html = renderToStaticMarkup(<PhotoViewer {...base} current={mk("v", { kind: "movie", name: "Clip" })} prev={null} next={null} />);
    const play = html.match(/<button[^>]*aria-label="Play video Clip"[^>]*>/)![0];
    expect(play).toContain("size-16"); // the circle, not the whole screen
    expect(play).not.toContain("inset-0");
  });
});
