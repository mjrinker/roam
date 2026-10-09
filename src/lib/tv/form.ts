/** Small helpers for the TV pages that change something with a POST. */

/** A "back" address from a form or link, kept only if it is one of this server's TV pages. */
export function safeBack(base: string, raw: string | null): string {
  return raw && raw.startsWith(`${base}/`) && !/[\\\u0000-\u001f]|\/\//.test(raw.slice(base.length)) && raw.length < 600 ? raw : base;
}

/** Whether an Origin header names the same host as the request ("null" and anything unparsable are not the same). */
export function sameHost(origin: string, requestUrl: string): boolean {
  try {
    return new URL(origin).host === new URL(requestUrl).host;
  } catch {
    return false;
  }
}
