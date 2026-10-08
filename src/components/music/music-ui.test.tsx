import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AlbumTile, ArtistTile } from "./music-cards";
import { AlbumPlayButtons, TrackList } from "./track-list";
import type { AlbumCard, ArtistCard } from "@/lib/music/browse";

const album: AlbumCard = { id: "al1", name: "Abbey Road", year: 1969, artistId: "ar1", artistName: "The Beatles", trackCount: 1, coverUrl: null, matched: true };
const artist: ArtistCard = { id: "ar1", name: "The Beatles", albumCount: 2, trackCount: 20, coverUrls: [] };

describe("music tiles", () => {
  it("link to the album and artist pages and say what they are, with singular and plural counts", () => {
    const a = renderToStaticMarkup(<AlbumTile serverId="s1" album={album} />);
    expect(a).toContain('href="/s/s1/album/al1"');
    expect(a).toContain("The Beatles · 1969 · 1 song");
    expect(a).not.toContain("1 songs");
    expect(renderToStaticMarkup(<AlbumTile serverId="s1" album={{ ...album, trackCount: 12, year: null }} showArtist={false} />)).toContain(">12 songs<");
    const r = renderToStaticMarkup(<ArtistTile serverId="s1" artist={artist} />);
    expect(r).toContain('href="/s/s1/artist/ar1"');
    expect(r).toContain("2 albums");
    expect(renderToStaticMarkup(<ArtistTile serverId="s1" artist={{ ...artist, albumCount: 1 }} />)).toContain(">1 album<");
  });
});

describe("track list", () => {
  const t = (id: string, name: string, trackNumber: number | null, discNumber: number | null, artistName: string | null = null) => ({ id, name, trackNumber, discNumber, durationSeconds: 125, artist: artistName });
  it("shows number, name, a differing artist and the length, and a dash for an unnumbered song", () => {
    const html = renderToStaticMarkup(<TrackList tracks={[t("a", "Come Together", 1, null), t("b", "Hidden", null, null, "Guest")]} />);
    expect(html).toContain("Come Together");
    expect(html).toContain("Guest");
    expect(html).toContain("2:05");
    expect(html).toContain(">–<");
    expect(html).not.toContain("Disc ");
  });
  it("adds a heading per disc only when there is more than one", () => {
    const html = renderToStaticMarkup(<TrackList tracks={[t("a", "x", 1, 1), t("b", "y", 2, 1), t("c", "z", 1, 2)]} />);
    expect(html.match(/Disc \d/g)).toEqual(["Disc 1", "Disc 2"]);
  });
  it("renders play and shuffle disabled outside the player", () => {
    const html = renderToStaticMarkup(<AlbumPlayButtons ids={["a"]} />);
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Shuffle");
  });
});
