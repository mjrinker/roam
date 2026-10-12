/** Calling a storage service's HTTP API with a connection's OAuth token: sign in again once on a 401, wait out rate limits, report other failures. */
import { accessTokenFor, type Refresher } from "@/lib/storage/oauth-tokens";
import { StorageReauthRequiredError } from "@/lib/storage/reauth";

export class StorageHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** The start of the response body, for matching what the service said ("path/not_found"). */
    public readonly body: string
  ) {
    super(message);
    this.name = "StorageHttpError";
  }
}

const MAX_ATTEMPTS = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `build(token)` (which makes the request) until it succeeds. A 401 refreshes the token once and retries; a second 401 means the
 * login is dead (StorageReauthRequiredError). 429 and 5xx wait (the service's Retry-After, else a growing pause) and retry.
 */
export async function authorizedCall(
  connectionId: string,
  refresher: Refresher,
  service: string,
  build: (token: string) => Promise<Response>,
  /** Failures beyond 429 and 5xx that mean "try again shortly" for this service (Google answers a rate limit with a 403). */
  isRateLimit: (status: number, body: string) => boolean = () => false
): Promise<Response> {
  let forced = false;
  for (let attempt = 1; ; attempt++) {
    const token = await accessTokenFor(connectionId, refresher, forced);
    const res = await build(token);
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    if (res.status === 401 && !forced) {
      forced = true;
      continue;
    }
    if (res.status === 401) throw new StorageReauthRequiredError(connectionId);
    if ((res.status === 429 || res.status >= 500 || isRateLimit(res.status, text)) && attempt < MAX_ATTEMPTS) {
      const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
      await sleep(Math.min(wait, 20) * 1000);
      continue;
    }
    throw new StorageHttpError(`${service} ${res.status}: ${text.slice(0, 200)}`, res.status, text.slice(0, 500));
  }
}
