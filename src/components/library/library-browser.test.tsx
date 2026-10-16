import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }));

import { LibraryBrowser, type LibraryBrowserItem } from "./library-browser";

const film = (id: string, name: string, year: number): LibraryBrowserItem => ({ id, kind: "movie", name, year, posterUrl: null, addedAtMs: 0, genres: [], runtimeSeconds: null, certification: null, ratingAge: null, imdbRating: null, rottenTomatoesScore: null, needsAudioFix: false, watched: false, progressFraction: null, processing: false });
const items = [film("a1", "Alien", 1979), film("a2", "Aliens", 1986), film("z1", "Zodiac", 2007)];
const index = { cards: { C1: { id: "C1", name: "Alien Collection", kind: "tmdb" as const, count: 2, posterUrl: null } }, byTitle: { a1: "C1", a2: "C1" } };

describe("LibraryBrowser", () => {
  it("shows every title when the profile does not group collections", () => {
    const html = renderToStaticMarkup(<LibraryBrowser items={items} serverId="s" collections={{ group: false, index }} />);
    expect(html).toContain("Alien<");
    expect(html).toContain("Aliens");
    expect(html).not.toContain("Alien Collection");
  });
  it("shows a collection as one tile where its first title was, when the profile groups them", () => {
    const html = renderToStaticMarkup(<LibraryBrowser items={items} serverId="s" collections={{ group: true, index }} />);
    expect(html).toContain("Alien Collection");
    expect(html).toContain("/s/s/collection/C1");
    expect(html).toContain("Zodiac");
    expect(html).not.toContain("/s/s/title/a1");
    expect(html).not.toContain("/s/s/title/a2");
    expect(html.indexOf("Alien Collection")).toBeLessThan(html.indexOf("Zodiac"));
    expect(html).toContain('id="card-a1"'); // the letter rail can still jump to it
  });
  it("is the plain grid without an index", () => {
    expect(renderToStaticMarkup(<LibraryBrowser items={items} serverId="s" />)).toContain("/s/s/title/a2");
  });
});
