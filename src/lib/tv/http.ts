/** Small helpers for the TV route handlers. */

/** The visitor's address as the platform reports it, or "unknown". */
export function clientAddress(request: Request): string {
  // x-vercel-forwarded-for is set by the platform and can't be supplied by the visitor; the others are fallbacks for other hosts.
  const h = request.headers;
  return h.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** An HTML response that no one may keep: the pages are per person. */
export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" },
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function redirectTo(request: Request, path: string, status: 302 | 303 = 302): Response {
  const target = new URL(path, request.url);
  // ?modern=0 / ?modern=1 (the switch for a newer browser's extras) must survive the hops between the short address and the page that reads it.
  const modern = new URL(request.url).searchParams.get("modern");
  if ((modern === "0" || modern === "1") && !target.searchParams.has("modern")) target.searchParams.set("modern", modern);
  return new Response(null, { status, headers: { location: target.toString(), "cache-control": "private, no-store" } });
}

export const TV_PAIR_COOKIE = "roam_tv_pair";
