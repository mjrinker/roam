/** Which address Roam is reached at, for links that must point at the main site however a TV got there. */

/** The site's origin from what someone typed, or null: it must be https (http only for localhost), with no login details, path or query. */
export function siteOrigin(input: string | null | undefined): string | null {
  let url: URL;
  try {
    url = new URL((input ?? "").trim());
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if (url.username || url.password) return null;
  if (!/^[a-z0-9.-]+$/i.test(url.hostname)) return null;
  return url.origin;
}

/**
 * The address to put in links a person opens on a phone (the QR code): the configured main site (NEXT_PUBLIC_APP_URL), because sessions
 * belong to one hostname and a phone is signed in at the main one, even when the TV came in through a shorter alias. Falls back to the
 * address the request came in on.
 */
export function canonicalOrigin(requestUrl: string, configured: string | undefined = process.env.NEXT_PUBLIC_APP_URL): string {
  return siteOrigin(configured) ?? new URL(requestUrl).origin;
}

/** The short hostname to type on a TV (NEXT_PUBLIC_TV_HOST), if one is configured and is a plain hostname. */
export function tvHost(configured: string | undefined = process.env.NEXT_PUBLIC_TV_HOST): string | null {
  const host = configured?.trim().toLowerCase();
  return host && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null;
}
