import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { extraCategoryOfFile } from "@/lib/extras/categories";
import { usesPlexDiscNumbers } from "@/lib/music/placement";
import { parseEpisodeAirDate, parseEpisodeFileName, parseMovieFileTitle, parseSeasonFolderName, parseTitleFolderName, movieVersionLabel } from "@/lib/scan/conventions";
import { subtitleFileParts } from "@/lib/scan/subtitle-names";
import { parsePlexMatch } from "@/lib/scan/plexmatch";
import NamingHelpPage from "./page";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("the naming help page", () => {
  const html = renderToStaticMarkup(<NamingHelpPage />);
  const plain = text(html);

  it("covers every kind of thing it explains, with a way to jump to each", () => {
    for (const id of ["basics", "movies", "tv", "extras", "subtitles", "posters", "music", "more", "formats"]) expect(html, id).toContain(`id="${id}"`);
    for (const word of ["{tmdb-272}", "{imdb-tt0372784}", "{tvdb-73244}", "{edition-Director's Cut}", "- pt1", "Season 00", "Specials", ".plexmatch", "-behindthescenes", "forced", "Various Artists", ".mkv"]) expect(plain, word).toContain(word);
  });

  it("only shows names Roam really reads (the examples are run through the real parsers)", () => {
    expect(parseTitleFolderName("Batman Begins (2005) {tmdb-272}")).toMatchObject({ name: "Batman Begins", year: 2005, tmdbId: 272 });
    expect(parseTitleFolderName("The Office (US) (2005) {tvdb-73244}").tvdbId).toBe(73244);
    expect(parseMovieFileTitle("Blade Runner (1982) {edition-Final Cut}.mp4")).toMatchObject({ name: "Blade Runner", edition: "Final Cut" });
    expect(movieVersionLabel("Pulp Fiction (1994) - for the phone.mp4")).toBe("for the phone");
    expect(movieVersionLabel("Blade Runner (1982).4k.hevc {edition-Final Cut}.mp4")).toBe("4k hevc");
    expect(parseSeasonFolderName("Specials")).toBe(0);
    expect(parseSeasonFolderName("S01")).toBe(1);
    expect(parseEpisodeFileName("Band of Brothers (2001) - s01e01 - Currahee.mp4")).toMatchObject({ season: 1, episode: 1, name: "Currahee" });
    expect(parseEpisodeFileName("Show - s01e01 [1080p Bluray].mp4")).toMatchObject({ episode: 1, name: null });
    expect(parseEpisodeFileName("Show - s02e18-e19.mp4")).toMatchObject({ episodes: [18, 19] });
    expect(parseEpisodeFileName("Show - s01e01 - 1080p.mp4")).toMatchObject({ version: "1080p" });
    expect(parseEpisodeAirDate("The Colbert Report (2005) - 2011-11-15 - Elijah Wood.mp4")).toBe("2011-11-15");
    for (const n of ["Teaser Trailer-trailer.mp4", "Bar Fight-deleted.mp4", "Sigourney Weaver-interview.mp4", "Show - s01e01 - Title-deleted2.mp4"]) expect(extraCategoryOfFile(n), n).not.toBeNull();
    for (const n of ["Avatar (2009).en.srt", "Avatar (2009).eng.srt", "Avatar (2009).en.forced.ass", "Avatar (2009).en.sdh.srt", "Show - s02e03.eng.srt"]) expect(subtitleFileParts(n), n).not.toBeNull();
    expect(usesPlexDiscNumbers(["101 - In the Flesh.mp3", "102 - The Thin Ice.mp3", "201 - Hey You.mp3"])).toBe(true);
    const hints = parsePlexMatch("title: Cool Show\nyear: 2018\ntmdbid: 12345\nseason: 2\nep: S02E01: The Beginning.mp4\nep: SP01: A Special.mp4\npattern: Part {e} of the story.mp4\n");
    expect(hints).toMatchObject({ title: "Cool Show", year: 2018, tmdbId: 12345, season: 2 });
    expect(hints.episodes).toHaveLength(2);
    expect(hints.patterns).toHaveLength(1);
  });
});
