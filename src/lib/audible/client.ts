import {
  parseAudnexusBook,
  parseAudnexusChapters,
  parseSearchProducts,
  type AudibleBook,
  type AudibleSearchResult,
  type AudnexusChapters,
} from "./parse";

/** Audible storefront regions: the region code Audnexus expects, and Audible's catalog API TLD. */
export const AUDIBLE_REGIONS = {
  us: ".com",
  uk: ".co.uk",
  ca: ".ca",
  au: ".com.au",
  de: ".de",
  fr: ".fr",
  it: ".it",
  es: ".es",
  in: ".in",
  jp: ".co.jp",
} as const;
export type AudibleRegion = keyof typeof AUDIBLE_REGIONS;

export function normalizeRegion(region: string | null | undefined): AudibleRegion {
  return region && region in AUDIBLE_REGIONS ? (region as AudibleRegion) : "us";
}

export class AudibleError extends Error {}
/** 429: back off for the rest of this pass rather than retrying. */
export class AudibleRateLimitedError extends AudibleError {}
/** 5xx or network failure: transient, leave the book pending. */
export class AudibleUnavailableError extends AudibleError {}

const REQUEST_TIMEOUT_MS = 8000;
const CACHE_SECONDS = 24 * 60 * 60;

/** GET JSON, mirroring tmdbFetch: bounded time, cached a day. Null on 404. */
async function audibleFetch(url: URL): Promise<unknown | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Roam/1.0 (private media server)" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      next: { revalidate: CACHE_SECONDS },
    });
  } catch (err) {
    throw new AudibleUnavailableError(`Audible request failed: ${(err as Error).message}`);
  }
  if (res.status === 404) return null;
  if (res.status === 429) throw new AudibleRateLimitedError("Audible rate limit reached");
  if (res.status >= 500) throw new AudibleUnavailableError(`Audible returned ${res.status}`);
  if (!res.ok) throw new AudibleError(`Audible returned ${res.status}`);
  return res.json();
}

/** Search Audible's public catalog (no API key). */
export async function searchAudible(
  query: { title: string; author?: string | null },
  region?: string | null
): Promise<AudibleSearchResult[]> {
  const url = new URL(`https://api.audible${AUDIBLE_REGIONS[normalizeRegion(region)]}/1.0/catalog/products`);
  url.searchParams.set("title", query.title);
  if (query.author) url.searchParams.set("author", query.author);
  url.searchParams.set("num_results", "10");
  url.searchParams.set("products_sort_by", "Relevance");
  url.searchParams.set("response_groups", "contributors,product_desc,media,series,product_attrs");
  return parseSearchProducts(await audibleFetch(url));
}

/** Full details for one ASIN via Audnexus. */
export async function getAudnexusBook(asin: string, region?: string | null): Promise<AudibleBook | null> {
  const url = new URL(`https://api.audnex.us/books/${encodeURIComponent(asin)}`);
  url.searchParams.set("region", normalizeRegion(region));
  return parseAudnexusBook(await audibleFetch(url));
}

/** Chapter markers for one ASIN via Audnexus (null when it has none). */
export async function getAudnexusChapters(
  asin: string,
  region?: string | null
): Promise<AudnexusChapters | null> {
  const url = new URL(`https://api.audnex.us/books/${encodeURIComponent(asin)}/chapters`);
  url.searchParams.set("region", normalizeRegion(region));
  return parseAudnexusChapters(await audibleFetch(url));
}
