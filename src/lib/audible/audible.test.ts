import { describe, expect, it } from "vitest";
import {
  htmlToText,
  parseAudnexusBook,
  parseAudnexusChapters,
  parseSearchProducts,
} from "./parse";
import { narratorSimilarity, pickBestMatch, rankMatches, tokens } from "./match";
import { normalizeRegion } from "./client";

const searchFixture = {
  total_results: 3,
  products: [
    {
      asin: "B003P2WO5E",
      title: "The Way of Kings",
      authors: [{ asin: "B001IGFHW6", name: "Brandon Sanderson" }],
      narrators: [{ name: "Michael Kramer" }, { name: "Kate Reading" }],
      runtime_length_min: 2726,
      release_date: "2010-08-31",
      product_images: { "500": "https://m.media-amazon.com/images/I/way.jpg" },
      series: [{ asin: "B00", title: "The Stormlight Archive", sequence: "1" }],
    },
    {
      asin: "B00NOSER1E",
      title: "The Way of Kings: A Study Guide",
      authors: [{ name: "Some Reviewer" }],
      narrators: [],
      runtime_length_min: 60,
      release_date: "2015-01-01",
    },
    { title: "Missing ASIN" },
    "garbage",
  ],
};

describe("parseSearchProducts", () => {
  const results = parseSearchProducts(searchFixture);

  it("parses complete products and skips malformed ones", () => {
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      asin: "B003P2WO5E",
      title: "The Way of Kings",
      authors: ["Brandon Sanderson"],
      narrators: ["Michael Kramer", "Kate Reading"],
      runtimeMinutes: 2726,
      releaseYear: 2010,
      imageUrl: "https://m.media-amazon.com/images/I/way.jpg",
      seriesName: "The Stormlight Archive",
      seriesPosition: "1",
      adult: false,
    });
  });

  it("tolerates missing optional fields", () => {
    expect(results[1]).toMatchObject({ imageUrl: null, seriesName: null, seriesPosition: null, narrators: [] });
  });

  it("returns an empty list for unexpected shapes", () => {
    expect(parseSearchProducts(null)).toEqual([]);
    expect(parseSearchProducts({})).toEqual([]);
    expect(parseSearchProducts({ products: "nope" })).toEqual([]);
  });
});

describe("parseAudnexusBook", () => {
  it("parses a book with a series, converting the HTML summary to text", () => {
    const book = parseAudnexusBook({
      asin: "B003P2WO5E",
      title: "The Way of Kings",
      authors: [{ asin: "x", name: "Brandon Sanderson" }],
      narrators: [{ name: "Michael Kramer" }],
      genres: [
        { asin: "1", name: "Science Fiction & Fantasy", type: "genre" },
        { asin: "2", name: "Epic", type: "tag" },
      ],
      image: "https://m.media-amazon.com/images/I/way.jpg",
      runtimeLengthMin: 2726,
      summary: "<p>Roshar is a world of <b>storms</b> &amp; stone.</p><p>Second&nbsp;paragraph.<br>Line two.</p>",
      releaseDate: "2010-08-31T00:00:00.000Z",
      seriesPrimary: { asin: "S1", name: "The Stormlight Archive", position: "1" },
    });
    expect(book).toMatchObject({
      asin: "B003P2WO5E",
      genres: ["Science Fiction & Fantasy"],
      releaseYear: 2010,
      seriesName: "The Stormlight Archive",
      seriesPosition: "1",
      summary: "Roshar is a world of storms & stone.\n\nSecond paragraph.\nLine two.",
    });
  });

  it("handles a standalone book (no seriesPrimary) and rejects junk", () => {
    expect(parseAudnexusBook({ asin: "B1", title: "Standalone" })).toMatchObject({ seriesName: null, genres: [] });
    expect(parseAudnexusBook({ title: "No asin" })).toBeNull();
    expect(parseAudnexusBook(null)).toBeNull();
  });
});

describe("parseAudnexusChapters", () => {
  it("parses and sorts chapters and reads intro/outro", () => {
    const parsed = parseAudnexusChapters({
      brandIntroDurationMs: 2000,
      brandOutroDurationMs: 5000,
      runtimeLengthMs: 3_600_000,
      chapters: [
        { title: "Chapter 2", startOffsetMs: 1_800_000, lengthMs: 1_800_000 },
        { title: "Opening Credits", startOffsetMs: 0, lengthMs: 1_800_000 },
      ],
    });
    expect(parsed).toEqual({
      runtimeMs: 3_600_000,
      introMs: 2000,
      outroMs: 5000,
      chapters: [
        { title: "Opening Credits", startSeconds: 0, lengthSeconds: 1800 },
        { title: "Chapter 2", startSeconds: 1800, lengthSeconds: 1800 },
      ],
    });
  });

  it("returns null when there are no usable chapters", () => {
    expect(parseAudnexusChapters({ chapters: [] })).toBeNull();
    expect(parseAudnexusChapters({})).toBeNull();
  });
});

describe("htmlToText", () => {
  it("decodes numeric entities and strips tags", () => {
    expect(htmlToText("<i>It&#39;s</i> &#x2014; fine")).toBe("It's — fine");
  });
});

describe("matching", () => {
  const results = parseSearchProducts(searchFixture);

  it("normalizes tokens", () => {
    expect(tokens("The Way of Kings (Unabridged)")).toEqual(["way", "of", "kings"]);
    expect(tokens("Café & Crème")).toEqual(["cafe", "and", "creme"]);
  });

  it("picks the real book over a study guide with a similar name", () => {
    const best = pickBestMatch({ title: "The Way of Kings", author: "Brandon Sanderson", year: 2010 }, results);
    expect(best?.asin).toBe("B003P2WO5E");
  });

  it("matches a folder-style 'Last, First' author regardless of order", () => {
    const best = pickBestMatch({ title: "Way of Kings", author: "Sanderson, Brandon" }, results);
    expect(best?.asin).toBe("B003P2WO5E");
  });

  it("rejects a wrong-author candidate with a merely similar title", () => {
    expect(pickBestMatch({ title: "The Way of Kings Study", author: "Brandon Sanderson" }, [results[1]])).toBeNull();
  });

  it("uses runtime to demote a wrong edition", () => {
    const abridged = { ...results[0], asin: "ABR", runtimeMinutes: 300 };
    const ranked = rankMatches({ title: "The Way of Kings", author: "Brandon Sanderson", runtimeMinutes: 2700 }, [
      abridged,
      results[0],
    ]);
    expect(ranked[0].result.asin).toBe("B003P2WO5E");
  });

  it("picks the edition read by the tagged narrator", () => {
    const wayOfKings = (asin: string, narrators: string[]) => ({
      ...results[0],
      asin,
      narrators: narrators,
      runtimeMinutes: null,
    });
    const candidates = [
      wayOfKings("OTHER", ["Someone Else"]),
      wayOfKings("KRAMER", ["Michael Kramer", "Kate Reading"]),
    ];
    const best = pickBestMatch(
      { title: "The Way of Kings", author: "Brandon Sanderson", narrators: ["Michael Kramer"] },
      candidates
    );
    expect(best?.asin).toBe("KRAMER");
    // Without a tag the first (equally good) candidate stands.
    expect(pickBestMatch({ title: "The Way of Kings", author: "Brandon Sanderson" }, candidates)?.asin).toBe("OTHER");
  });

  it("matches narrator names regardless of order or accents", () => {
    expect(narratorSimilarity(["Porter, Ray"], ["Ray Porter"])).toBe(1);
    expect(narratorSimilarity(["Zoe Urkel"], ["Zoë Ürkel"])).toBe(1);
    expect(narratorSimilarity(["Ray Porter"], ["Kate Reading"])).toBe(0);
  });

  it("returns null when nothing is close", () => {
    expect(pickBestMatch({ title: "Completely Different Book" }, results)).toBeNull();
  });
});

describe("normalizeRegion", () => {
  it("passes known regions and defaults unknown ones to us", () => {
    expect(normalizeRegion("uk")).toBe("uk");
    expect(normalizeRegion("xx")).toBe("us");
    expect(normalizeRegion(null)).toBe("us");
  });
});
