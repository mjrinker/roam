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

describe("PhotoTimeline", () => {
  const props = { serverId: "srv", libraryId: "lib", words: { add: "Add to favorites", remove: "Remove from favorites" } };

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

describe("favorites in the interface", () => {
  it("a tile shows a heart only when it is a favorite", () => {
    expect(renderToStaticMarkup(<PhotoTile serverId="srv" item={item()} from="from=timeline" />)).not.toContain("fill-rose-500");
    expect(renderToStaticMarkup(<PhotoTile serverId="srv" item={{ ...item(), favorite: true }} from="from=timeline" />)).toContain("fill-rose-500");
  });

  it("a favorites timeline links tiles with where they came from and speaks in the profile's spelling", () => {
    const html = renderToStaticMarkup(<PhotoTimeline serverId="srv" libraryId="lib" view="favorites" initialNext={null} initialItems={[item()]} words={{ add: "a", remove: "r" }} />);
    expect(html).toContain("?from=favorites");
    const empty = renderToStaticMarkup(<PhotoTimeline serverId="srv" libraryId="lib" view="favorites" initialNext={null} initialItems={[]} emptyTitle="No favourites yet" emptyHint="Tap the heart…" words={{ add: "a", remove: "r" }} />);
    expect(empty).toContain("No favourites yet");
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
  const props = { serverId: "srv", libraryId: "lib", initialNext: null, words: { add: "Add to favorites", remove: "Remove from favorites" } };
  const items = [item({ id: "a", takenAt: "2024-03-30T10:00:00Z" }), item({ id: "b", takenAt: "2024-03-02T10:00:00Z" })];

  it("offers days, months and years, starting at months, with the other levels one tap away", () => {
    const html = renderToStaticMarkup(<PhotoTimeline {...props} initialItems={items} />);
    expect(html).toContain('aria-label="Zoom"');
    for (const label of ["Days", "Months", "Years"]) expect(html).toContain(label);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("March 2024"); // month headings by default
  });

  it("an empty search says so and suggests what to try, instead of 'no photos yet'", () => {
    const html = renderToStaticMarkup(<PhotoTimeline {...props} initialItems={[]} q="zzz" />);
    expect(html).toContain("Nothing matches");
    expect(html).toContain("zzz");
    expect(html).not.toContain("No photos yet");
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
});
