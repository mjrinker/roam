/**
 * The short description of an artist or album from Wikipedia (text under CC BY-SA 4.0, so it is shown with the article's name, a link to it and
 * the licence), found from the Wikipedia or Wikidata link MusicBrainz has for it. Never searched for by name: a wrong article is worse than none.
 */
import { MB_USER_AGENT } from "@/lib/music/musicbrainz";

type Fetch = typeof fetch;
const TIMEOUT_MS = 8_000;
/** The longest summary kept, cut at a sentence. */
export const MAX_SUMMARY_CHARS = 1400;
export const WIKIPEDIA_LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";

export interface WikiSummary {
  title: string;
  extract: string;
  url: string;
}

/** The language edition and article title of a Wikipedia address, or null when it isn't one. */
export function parseWikipediaUrl(url: string): { lang: string; title: string } | null {
  const m = /^https:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/([^?#]+)$/.exec(url);
  if (!m) return null;
  try {
    return { lang: m[1], title: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

/** The text cut to at most `max` characters, at the end of a sentence when there is one in the second half, else at a word, with an ellipsis. */
export function trimSummary(text: string, max = MAX_SUMMARY_CHARS): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence > max / 2) return cut.slice(0, sentence + 1);
  const word = cut.lastIndexOf(" ");
  return `${cut.slice(0, word > 0 ? word : max).trimEnd()}…`;
}

export interface WikipediaClient {
  /** The English article title for a Wikidata item, or null. */
  englishTitle(wikidataId: string): Promise<string | null>;
  /** The summary of an article (null for a missing page or a disambiguation page). */
  summary(lang: string, title: string): Promise<WikiSummary | null>;
}

export function createWikipedia(opts: { fetch?: Fetch; userAgent?: string } = {}): WikipediaClient {
  const doFetch = opts.fetch ?? fetch;
  const headers = { "user-agent": opts.userAgent ?? MB_USER_AGENT, accept: "application/json" };
  return {
    async englishTitle(wikidataId) {
      if (!/^Q\d+$/.test(wikidataId)) return null;
      const res = await doFetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${wikidataId}&props=sitelinks&sitefilter=enwiki&format=json`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
      const data = (await res.json()) as { entities?: Record<string, { sitelinks?: { enwiki?: { title?: string } } }> };
      return data.entities?.[wikidataId]?.sitelinks?.enwiki?.title ?? null;
    },
    async summary(lang, title) {
      if (!/^[a-z-]{2,12}$/.test(lang)) return null;
      const res = await doFetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Wikipedia answered ${res.status}`);
      const data = (await res.json()) as { type?: string; title?: string; extract?: string; content_urls?: { desktop?: { page?: string } } };
      const url = data.content_urls?.desktop?.page;
      if (data.type === "disambiguation" || !data.extract?.trim() || !url || !/^https:\/\/[a-z-]+\.wikipedia\.org\//.test(url)) return null;
      return { title: data.title ?? title, extract: trimSummary(data.extract), url };
    },
  };
}

/** The article for a MusicBrainz entity's links: its English Wikipedia page (from Wikidata, or the link itself when that is English), else a linked page in another language. */
export async function articleFor(wiki: WikipediaClient, links: { wikidataId: string | null; wikipediaUrl: string | null }): Promise<WikiSummary | null> {
  const linked = links.wikipediaUrl ? parseWikipediaUrl(links.wikipediaUrl) : null;
  if (linked?.lang === "en") return wiki.summary("en", linked.title);
  const english = links.wikidataId ? await wiki.englishTitle(links.wikidataId) : null;
  if (english) {
    const found = await wiki.summary("en", english);
    if (found) return found;
  }
  return linked ? wiki.summary(linked.lang, linked.title) : null;
}
