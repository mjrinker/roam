import { describe, expect, it } from "vitest";
import { linksFromRelations } from "./musicbrainz";
import { articleFor, createWikipedia, parseWikipediaUrl, trimSummary, MAX_SUMMARY_CHARS, type WikipediaClient } from "./wikipedia";
import { createSimilarArtists, parseSimilar } from "./similar-artists";

const ID = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

describe("links on a MusicBrainz entity", () => {
  it("finds the Wikidata item and the Wikipedia article among the relations, ignoring everything else", () => {
    const links = linksFromRelations("Nirvana", [
      { type: "allmusic", url: { resource: "https://www.allmusic.com/artist/mn0000357406" } },
      { type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q11649" } },
      { type: "wikipedia", url: { resource: "https://en.wikipedia.org/wiki/Nirvana_(band)" } },
      { type: "wikipedia", url: { resource: "https://de.wikipedia.org/wiki/Nirvana_(Band)" } },
    ]);
    expect(links).toEqual({ name: "Nirvana", wikidataId: "Q11649", wikipediaUrl: "https://en.wikipedia.org/wiki/Nirvana_(band)" });
  });
  it("has nothing when there are no such links, and refuses addresses that are not those sites", () => {
    expect(linksFromRelations("X", undefined)).toEqual({ name: "X", wikidataId: null, wikipediaUrl: null });
    expect(linksFromRelations("X", [{ type: "wikidata", url: { resource: "https://evil.example/wiki/Q1" } }, { type: "wikipedia", url: { resource: "https://evil.example/wiki/Page" } }])).toEqual({ name: "X", wikidataId: null, wikipediaUrl: null });
  });
});

describe("Wikipedia", () => {
  it("reads the language and title of an article address, with its escapes", () => {
    expect(parseWikipediaUrl("https://en.wikipedia.org/wiki/Nirvana_(band)")).toEqual({ lang: "en", title: "Nirvana_(band)" });
    expect(parseWikipediaUrl("https://de.wikipedia.org/wiki/Die_%C3%84rzte")).toEqual({ lang: "de", title: "Die_Ärzte" });
    expect(parseWikipediaUrl("https://example.com/wiki/Thing")).toBeNull();
    expect(parseWikipediaUrl("https://en.wikipedia.org/wiki/%E0%A4%A")).toBeNull();
  });

  it("cuts a long summary at a sentence, else at a word, and leaves a short one alone", () => {
    expect(trimSummary("  A short   one. ")).toBe("A short one.");
    const sentences = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} ends here.`).join(" ");
    const cut = trimSummary(sentences);
    expect(cut.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(cut.endsWith("here.")).toBe(true);
    const noStops = "word ".repeat(600);
    const cutWords = trimSummary(noStops, 100);
    expect(cutWords.endsWith("…")).toBe(true);
    expect(cutWords.length).toBeLessThanOrEqual(101);
  });

  it("asks the right addresses, with a descriptive User-Agent, and drops a disambiguation page or a missing one", async () => {
    const asked: { url: string; ua: string | null }[] = [];
    const wiki = createWikipedia({
      fetch: (async (url: string, init?: RequestInit) => {
        asked.push({ url, ua: new Headers(init?.headers).get("user-agent") });
        if (url.includes("wikidata.org")) return new Response(JSON.stringify({ entities: { Q1: { sitelinks: { enwiki: { title: "Some Band" } } } } }));
        if (url.includes("Some_Band")) return new Response(JSON.stringify({ type: "standard", title: "Some Band", extract: "Some Band is a band.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Some_Band" } } }));
        if (url.includes("Mercury")) return new Response(JSON.stringify({ type: "disambiguation", title: "Mercury", extract: "Mercury may refer to", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Mercury" } } }));
        return new Response("{}", { status: 404 });
      }) as never,
    });
    expect(await wiki.englishTitle("Q1")).toBe("Some Band");
    expect(await wiki.englishTitle("not-an-id")).toBeNull();
    expect(await wiki.summary("en", "Some Band")).toEqual({ title: "Some Band", extract: "Some Band is a band.", url: "https://en.wikipedia.org/wiki/Some_Band" });
    expect(await wiki.summary("en", "Mercury")).toBeNull();
    expect(await wiki.summary("en", "Nothing here")).toBeNull();
    expect(await wiki.summary("../evil", "x")).toBeNull();
    expect(asked.every((a) => /Roam/.test(a.ua ?? ""))).toBe(true);
    expect(asked[0].url).toContain("ids=Q1");
  });

  it("finds an article from the English link first, else through Wikidata, else another language", async () => {
    const calls: string[] = [];
    const wiki: WikipediaClient = {
      englishTitle: async (q) => (calls.push(`wd:${q}`), q === "Q2" ? "Via Wikidata" : null),
      summary: async (lang, title) => (calls.push(`${lang}:${title}`), title === "Missing" ? null : { title, extract: `About ${title}`, url: `https://${lang}.wikipedia.org/wiki/${title}` }),
    };
    expect((await articleFor(wiki, { wikidataId: "Q9", wikipediaUrl: "https://en.wikipedia.org/wiki/Direct" }))?.title).toBe("Direct");
    expect(calls).toEqual(["en:Direct"]); // Wikidata not asked
    calls.length = 0;
    expect((await articleFor(wiki, { wikidataId: "Q2", wikipediaUrl: "https://de.wikipedia.org/wiki/Deutsch" }))?.title).toBe("Via Wikidata");
    calls.length = 0;
    expect((await articleFor(wiki, { wikidataId: "Q3", wikipediaUrl: "https://de.wikipedia.org/wiki/Deutsch" }))?.url).toBe("https://de.wikipedia.org/wiki/Deutsch");
    expect(await articleFor(wiki, { wikidataId: null, wikipediaUrl: null })).toBeNull();
  });
});

describe("similar artists", () => {
  it("keeps well-formed entries, best first, without the artist itself or repeats", () => {
    const rows = [
      { artist_mbid: ID(1), name: "Self", score: 99999 },
      { artist_mbid: ID(2), name: "Low", score: 10 },
      { artist_mbid: ID(3), name: " High ", score: 500 },
      { artist_mbid: ID(3), name: "High again", score: 400 },
      { artist_mbid: "nope", name: "Bad id", score: 1 },
      { artist_mbid: ID(4), name: "", score: 1 },
      { artist_mbid: ID(5), name: "No score" },
      "junk",
    ];
    expect(parseSimilar(rows, ID(1)).map((s) => [s.name, s.score])).toEqual([["High", 500], ["Low", 10], ["No score", 0]]);
    expect(parseSimilar({ not: "a list" }, ID(1))).toEqual([]);
    expect(parseSimilar(Array.from({ length: 80 }, (_, i) => ({ artist_mbid: ID(i + 10), name: `A${i}`, score: i })), ID(1))).toHaveLength(30);
  });

  it("asks ListenBrainz with the artist's id only, and treats 404 as nothing and other failures as errors", async () => {
    const urls: string[] = [];
    const ok = createSimilarArtists({ fetch: (async (url: string) => (urls.push(url), new Response(JSON.stringify([{ artist_mbid: ID(2), name: "Other", score: 5 }])))) as never });
    expect(await ok.similarTo(ID(1))).toHaveLength(1);
    expect(urls[0]).toContain(`artist_mbids=${ID(1)}`);
    expect(await ok.similarTo("not an id")).toEqual([]);
    const missing = createSimilarArtists({ fetch: (async () => new Response("", { status: 404 })) as never });
    expect(await missing.similarTo(ID(1))).toEqual([]);
    const broken = createSimilarArtists({ fetch: (async () => new Response("", { status: 500 })) as never });
    await expect(broken.similarTo(ID(1))).rejects.toThrow(/500/);
  });
});
