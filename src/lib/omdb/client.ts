import { parseOmdbResponse, type OmdbRatings } from "@/lib/omdb/parse";

const OMDB_API_BASE = "https://www.omdbapi.com/";
const REQUEST_TIMEOUT_MS = 8000;
// Ratings barely move day to day; cache generously to stay well inside the
// free tier's daily request cap.
const CACHE_SECONDS = 7 * 24 * 60 * 60;

export class OmdbError extends Error {}
export class OmdbRateLimitedError extends OmdbError {}
export class OmdbUnavailableError extends OmdbError {}

function getApiKey(): string | null {
  return process.env.OMDB_API_KEY?.trim() || null;
}

export function isOmdbConfigured(): boolean {
  return getApiKey() !== null;
}

/**
 * IMDb rating + Rotten Tomatoes Tomatometer for one title, via OMDb. Returns
 * null when OMDb has nothing for this id (not an error — most titles do have
 * an entry, but a handful of obscure ones won't). Throws only on a real
 * request failure (network, rate limit, misconfiguration).
 */
export async function getOmdbRatings(imdbId: string): Promise<OmdbRatings | null> {
  const apiKey = getApiKey();
  if (!apiKey) throw new OmdbError("OMDB_API_KEY is not set");

  const url = new URL(OMDB_API_BASE);
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("i", imdbId);

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      next: { revalidate: CACHE_SECONDS },
    });
  } catch (err) {
    throw new OmdbUnavailableError(`OMDb request failed: ${(err as Error).message}`);
  }
  if (res.status === 401) throw new OmdbError("OMDb rejected the API key");
  if (res.status === 429) throw new OmdbRateLimitedError("OMDb rate limit reached");
  if (res.status >= 500) throw new OmdbUnavailableError(`OMDb returned ${res.status}`);
  if (!res.ok) throw new OmdbError(`OMDb returned ${res.status}`);

  const body = await res.json();
  // OMDb's own rate-limit message comes back as 200 with a JSON error body.
  if (isObject(body) && typeof body.Error === "string" && /limit/i.test(body.Error)) {
    throw new OmdbRateLimitedError(body.Error);
  }
  return parseOmdbResponse(body);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
