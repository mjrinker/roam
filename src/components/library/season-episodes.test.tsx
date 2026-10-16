import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }));

import { SeasonEpisodes, type EpisodeRowData } from "./season-episodes";

const ep = (id: string, number: number, myRating: number | null): EpisodeRowData => ({ id, seasonId: "s1", number, name: `Ep ${number}`, overview: null, stillUrl: null, runtimeLabel: null, ready: true, progressFraction: 0, watched: false, myRating, chapters: [], guide: [] });

describe("episode rows", () => {
  it("each carry the profile's own star rating, with the rated half stars filled", () => {
    const html = renderToStaticMarkup(<SeasonEpisodes serverId="s" seasons={[{ id: "s1", number: 1 }]} episodes={[ep("e1", 1, 7), ep("e2", 2, null)]} initialSeasonId="s1" prefs={{}} />);
    expect(html.match(/role="radiogroup"/g)).toHaveLength(2);
    expect(html).toContain("3.5"); // episode one, three and a half stars
    expect(html).toContain("Rate"); // episode two, none yet
    expect(html).toContain('aria-label="3.5 stars"');
    expect(html).toContain('aria-checked="true"');
  });
});
