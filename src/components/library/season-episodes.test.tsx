import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }));

import { SeasonEpisodes, type EpisodeRowData } from "./season-episodes";

const ep = (id: string, number: number, myRating: number | null): EpisodeRowData => ({ id, seasonId: "s1", number, name: `Ep ${number}`, overview: null, stillUrl: null, runtimeLabel: null, ready: true, progressFraction: 0, watched: false, myRating, average: null, chapters: [], guide: [] });

describe("episode rows", () => {
  it("each carry the profile's own star rating, with the rated half stars filled", () => {
    const html = renderToStaticMarkup(<SeasonEpisodes serverId="s" seasons={[{ id: "s1", number: 1 }]} episodes={[ep("e1", 1, 7), ep("e2", 2, null)]} initialSeasonId="s1" prefs={{}} />);
    expect(html.match(/role="radiogroup"/g)).toHaveLength(2);
    expect(html).toContain("3.5"); // episode one, three and a half stars
    expect(html).toContain("Rate"); // episode two, none yet
    expect(html).toContain('aria-label="3.5 stars"');
    expect(html).toContain('aria-checked="true"');
  });

  it("show the server's average in white when the profile has not rated, and the profile's own in the accent colour", () => {
    const withAverage = { ...ep("e3", 3, null), average: { halfStars: 8.4, count: 5 } };
    const html = renderToStaticMarkup(<SeasonEpisodes serverId="s" seasons={[{ id: "s1", number: 1 }]} episodes={[withAverage, { ...ep("e4", 4, 4), average: { halfStars: 9, count: 3 } }]} initialSeasonId="s1" prefs={{}} />);
    expect(html).toContain("4 avg (5)"); // 8.4 half stars is four stars
    expect(html).toContain("fill-white");
    expect((html.match(/fill-white/g) ?? []).length).toBe(5); // the first row's five star overlays are white; the second row (its own rating) has none
    expect(html).toContain("Average of 5 ratings on this server");
    expect(html).not.toContain("avg (3)"); // the second has a rating of its own
  });
});
