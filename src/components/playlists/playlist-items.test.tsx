import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlaylistItems, detailsHref, itemHref } from "./playlist-items";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
import type { ItemRow } from "./playlist-api";

const row = (over: Partial<ItemRow>): ItemRow => ({
  id: "item-1",
  titleId: "title-1",
  episodeId: null,
  titleKind: "movie",
  name: "Heat",
  year: 1995,
  posterUrl: null,
  seasonNumber: null,
  episodeNumber: null,
  showName: null,
  showId: null,
  playable: true,
  ...over,
});

describe("itemHref", () => {
  it("plays movies and episodes with the queue context, opens shows, and sends books to their page", () => {
    expect(itemHref("s1", "p1", row({}))).toBe("/s/s1/watch/title/title-1?playlist=p1&item=item-1");
    expect(itemHref("s1", "p1", row({ titleId: null, episodeId: "ep-1", titleKind: null }))).toBe(
      "/s/s1/watch/episode/ep-1?playlist=p1&item=item-1"
    );
    expect(itemHref("s1", "p1", row({ titleKind: "show" }))).toBe("/s/s1/show/title-1");
    expect(itemHref("s1", "p1", row({ titleKind: "audiobook" }))).toBe("/s/s1/book/title-1?playlist=p1&item=item-1");
  });
});

describe("detailsHref (where clicking a row goes; the play button uses itemHref)", () => {
  it("goes to the details page of a movie, of an episode's show, of a show and of a book", () => {
    expect(detailsHref("s1", "p1", row({}))).toBe("/s/s1/title/title-1");
    expect(detailsHref("s1", "p1", row({ titleId: null, episodeId: "ep-1", titleKind: null, showId: "show-1" }))).toBe("/s/s1/show/show-1");
    expect(detailsHref("s1", "p1", row({ titleKind: "show" }))).toBe("/s/s1/show/title-1");
    expect(detailsHref("s1", "p1", row({ titleKind: "audiobook" }))).toBe("/s/s1/book/title-1");
  });
  it("never carries the queue, which only playing does", () => {
    expect(detailsHref("s1", "p1", row({}))).not.toContain("playlist=");
    expect(itemHref("s1", "p1", row({}))).toContain("playlist=p1");
  });
});

describe("PlaylistItems", () => {
  const render = (items: ItemRow[], canEdit: boolean, cursor: string | null = null) =>
    renderToStaticMarkup(
      <PlaylistItems serverId="s1" playlistId="p1" initialItems={items} initialCursor={cursor} canEdit={canEdit} />
    );

  it("shows the empty state", () => {
    expect(render([], true)).toContain("Nothing here yet");
  });

  it("renders names, kinds and play links, with episode context", () => {
    const html = render(
      [
        row({}),
        row({ id: "item-2", titleId: null, episodeId: "ep-1", titleKind: null, name: "Pilot", showName: "Lost", seasonNumber: 1, episodeNumber: 1 }),
      ],
      false
    );
    expect(html).toContain("Heat");
    expect(html).toContain("Movie · 1995");
    expect(html).toContain("Lost — S1 · E1 · Pilot");
    expect(html).toContain('href="/s/s1/watch/title/title-1?playlist=p1&amp;item=item-1"'); // the play button
    expect(html).toContain('href="/s/s1/title/title-1"'); // the name opens the details
  });

  it("shows each of the values it is ordered by, in order", () => {
    const html = render([row({ sortLabels: ["1995", "1h 40m", "IMDb 8.5"] })], false);
    expect(html.indexOf("1995")).toBeLessThan(html.indexOf("1h 40m"));
    expect(html.indexOf("1h 40m")).toBeLessThan(html.indexOf("IMDb 8.5"));
    expect(render([row({})], false)).not.toContain("What this playlist is ordered by");
  });

  it("disables a show with nothing playable instead of linking it", () => {
    const html = render([row({ titleKind: "show", name: "Empty show", playable: false })], false);
    expect(html).toContain("nothing playable yet");
    expect(html).not.toContain("/show/title-1");
  });

  it("only offers edit controls to editors, and 'Load more' when there is another page", () => {
    expect(render([row({})], false)).not.toContain("Move up");
    const editing = render([row({}), row({ id: "item-2" })], true, "cursor-token");
    expect(editing).toContain("Move up");
    expect(editing).toContain("Move down");
    expect(editing).toContain("Remove Heat");
    expect(editing).toContain("Load more");
    expect(render([row({})], true)).not.toContain("Load more");
  });
});
