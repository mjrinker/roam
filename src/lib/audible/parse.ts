/**
 * Pure parsers for Audible's public catalog API and Audnexus. Both are
 * unofficial, so everything here is defensive: unknown or missing fields
 * become null/empty rather than throwing.
 */

export interface AudibleSearchResult {
  asin: string;
  title: string;
  authors: string[];
  narrators: string[];
  runtimeMinutes: number | null;
  releaseYear: number | null;
  imageUrl: string | null;
  seriesName: string | null;
  seriesPosition: string | null;
}

export interface AudibleBook extends AudibleSearchResult {
  summary: string | null;
  genres: string[];
}

export interface AudnexusChapters {
  chapters: { title: string; startSeconds: number; lengthSeconds: number }[];
  runtimeMs: number | null;
  introMs: number;
  outroMs: number;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function names(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (isObject(x) ? str(x.name) : str(x))).filter((n): n is string => !!n);
}

function yearOf(v: unknown): number | null {
  const m = /^(\d{4})/.exec(str(v) ?? "");
  return m ? Number(m[1]) : null;
}

/** Turns Audible's HTML blurbs into plain text (paragraphs kept as blank-line breaks). Never render the result as HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `products[]` from GET api.audible.com/1.0/catalog/products. */
export function parseSearchProducts(json: unknown): AudibleSearchResult[] {
  if (!isObject(json) || !Array.isArray(json.products)) return [];
  const results: AudibleSearchResult[] = [];
  for (const p of json.products) {
    if (!isObject(p)) continue;
    const asin = str(p.asin);
    const title = str(p.title);
    if (!asin || !title) continue;

    const series = Array.isArray(p.series) && isObject(p.series[0]) ? p.series[0] : null;
    const images = isObject(p.product_images) ? p.product_images : {};
    results.push({
      asin,
      title,
      authors: names(p.authors),
      narrators: names(p.narrators),
      runtimeMinutes: num(p.runtime_length_min),
      releaseYear: yearOf(p.release_date),
      imageUrl: str(images["500"]) ?? str(Object.values(images)[0]),
      seriesName: series ? str(series.title) : null,
      seriesPosition: series ? str(series.sequence) : null,
    });
  }
  return results;
}

/** GET api.audnex.us/books/{asin}. */
export function parseAudnexusBook(json: unknown): AudibleBook | null {
  if (!isObject(json)) return null;
  const asin = str(json.asin);
  const title = str(json.title);
  if (!asin || !title) return null;

  const series = isObject(json.seriesPrimary) ? json.seriesPrimary : null;
  const genres = Array.isArray(json.genres)
    ? json.genres
        .filter((g): g is Json => isObject(g) && (g.type === undefined || g.type === "genre"))
        .map((g) => str(g.name))
        .filter((n): n is string => !!n)
    : [];
  const summary = str(json.summary);

  return {
    asin,
    title,
    authors: names(json.authors),
    narrators: names(json.narrators),
    runtimeMinutes: num(json.runtimeLengthMin),
    releaseYear: yearOf(json.releaseDate),
    imageUrl: str(json.image),
    seriesName: series ? str(series.name) : null,
    seriesPosition: series ? str(series.position) : null,
    summary: summary ? htmlToText(summary) || null : null,
    genres,
  };
}

/** GET api.audnex.us/books/{asin}/chapters. */
export function parseAudnexusChapters(json: unknown): AudnexusChapters | null {
  if (!isObject(json) || !Array.isArray(json.chapters)) return null;
  const chapters = json.chapters
    .filter(isObject)
    .map((c, i) => {
      const startMs = num(c.startOffsetMs) ?? (num(c.startOffsetSec) !== null ? (num(c.startOffsetSec) as number) * 1000 : null);
      if (startMs === null) return null;
      return {
        title: str(c.title) ?? `Chapter ${i + 1}`,
        startSeconds: startMs / 1000,
        lengthSeconds: (num(c.lengthMs) ?? 0) / 1000,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => a.startSeconds - b.startSeconds);
  if (chapters.length === 0) return null;

  return {
    chapters,
    runtimeMs: num(json.runtimeLengthMs) ?? (num(json.runtimeLengthSec) !== null ? (num(json.runtimeLengthSec) as number) * 1000 : null),
    introMs: num(json.brandIntroDurationMs) ?? 0,
    outroMs: num(json.brandOutroDurationMs) ?? 0,
  };
}
