import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WishlistView } from "./wishlist-view";
import type { WishView } from "@/lib/wishlist/service";

const wish = (over: Partial<WishView>): WishView => ({
  id: "w1", kind: "movie", title: "Heat", year: 1995, creator: null, tmdbId: 949, posterUrl: null, overview: null, note: null, status: "wanted", wants: 1, wantedBy: [], iWant: false,
  claimedByName: null, claimedByMe: false, canRemove: false, onServer: null, createdAt: "2026-10-17T00:00:00.000Z", ...over,
});

describe("WishlistView", () => {
  it("lists wishes with how many households want each and by whom, and the actions a member can take", () => {
    const html = renderToStaticMarkup(<WishlistView serverId="s1" canEdit initial={[wish({ wants: 2, wantedBy: ["Ann"], note: "director's cut" }), wish({ id: "w2", kind: "audiobook", title: "Dune", year: null, creator: "Frank Herbert", canRemove: true })]} />);
    expect(html).toContain("Heat");
    expect(html).toContain("(1995)");
    expect(html).toContain("2 households want this · Ann");
    expect(html).toContain("1 household wants this");
    expect(html).toContain("director&#x27;s cut");
    expect(html).toContain("Frank Herbert");
    expect(html).toContain("I want this too");
    expect(html).toContain("I&#x27;ll get this");
    expect(html).toContain("Remove");
    expect(html).toContain("</svg> Add</button>");
    expect(html).toContain("Everything · 2");
    expect(html).toContain("Audiobook · 1");
  });

  it("says who is getting something, and offers We got it", () => {
    const html = renderToStaticMarkup(<WishlistView serverId="s1" canEdit initial={[wish({ status: "claimed", claimedByName: "Bob", claimedByMe: false }), wish({ id: "w2", title: "Mine", status: "claimed", claimedByMe: true })]} />);
    expect(html).toContain("Bob is getting this");
    expect(html).toContain("You&#x27;re getting this");
    expect(html).toContain("We got it");
    expect(html).toContain("Not me after all");
  });

  it("hides what is got or already on the server, but offers to show it, and links to the title that arrived", () => {
    const html = renderToStaticMarkup(<WishlistView serverId="s1" canEdit initial={[wish({ title: "Open" }), wish({ id: "w2", title: "Arrived", onServer: { titleId: "t9" } }), wish({ id: "w3", title: "Bought", status: "got" })]} />);
    expect(html).toContain("Open");
    expect(html).not.toContain("Arrived");
    expect(html).not.toContain("Bought");
    expect(html).toContain("Show what&#x27;s got (2)");
  });

  it("is read-only for a profile that can't change it, and says when there is nothing", () => {
    const html = renderToStaticMarkup(<WishlistView serverId="s1" canEdit={false} initial={[wish({ canRemove: true })]} />);
    expect(html).toContain("Heat");
    for (const label of ["I want this too", "I&#x27;ll get this", "Remove", "</svg> Add</button>"]) expect(html).not.toContain(label);
    expect(renderToStaticMarkup(<WishlistView serverId="s1" canEdit initial={[]} />)).toContain("Nothing on the wishlist yet.");
  });
});
