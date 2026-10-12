/**
 * Roam's Google Drive stream relay, for Cloudflare Workers. Google Drive has no per-file download links, so Roam hands a player a link
 * to this Worker instead: /s/<sealed>, where <sealed> is AES-GCM encrypted by Roam (with the secret both sides hold) and says one Drive
 * file, a short-lived Google access token for it, and when it all expires. The Worker opens it, asks Google for that file with the
 * player's Range header, and passes the bytes back. The browser can't read the sealed part, so the token never leaves Roam and this
 * Worker, and one link reads one file for under an hour. Cloudflare doesn't charge for the bandwidth, which is the point of it.
 *
 * Deploy: see README.md in this folder. Uses only standard Worker APIs (fetch, WebCrypto).
 */

export interface Env {
  /** The same base64 32-byte secret as Roam's STREAM_SECRET. */
  STREAM_SECRET: string;
}

interface Sealed {
  f: string; // Google Drive file id
  t: string; // Google access token
  e: number; // expiry, ms since the epoch
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges" };
const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];

const fromB64 = (s: string, url: boolean): Uint8Array => {
  const b = atob(url ? s.replace(/-/g, "+").replace(/_/g, "/") : s);
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** The sealed link's contents, or null when it is malformed, was not sealed with this secret, or has expired. */
export async function open(sealed: string, secret: string, now = Date.now()): Promise<Sealed | null> {
  try {
    const keyBytes = fromB64(secret, false);
    if (keyBytes.length !== 32) return null;
    const bytes = fromB64(sealed, true);
    if (bytes.length < 12 + 16 + 2) return null;
    const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, ["decrypt"]);
    // iv (12 bytes) then ciphertext with its 16-byte tag appended, which is what WebCrypto expects.
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) as BufferSource }, key, bytes.slice(12) as BufferSource);
    const p = JSON.parse(new TextDecoder().decode(plain)) as Partial<Sealed>;
    if (typeof p.f !== "string" || typeof p.t !== "string" || typeof p.e !== "number" || p.e < now) return null;
    return { f: p.f, t: p.t, e: p.e };
  } catch {
    return null;
  }
}

export async function handle(request: Request, env: Env, upstream: typeof fetch = fetch): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Range", "Access-Control-Max-Age": "86400" } });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

  const match = /^\/s\/([A-Za-z0-9_-]+)$/.exec(new URL(request.url).pathname);
  const sealed = match ? await open(match[1], env.STREAM_SECRET) : null;
  if (!sealed) return new Response("Not found", { status: 404 });

  const headers: Record<string, string> = { Authorization: `Bearer ${sealed.t}` };
  const range = request.headers.get("range");
  if (range) headers.Range = range;
  let res: Response;
  try {
    res = await upstream(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sealed.f)}?alt=media&supportsAllDrives=true`, { headers });
  } catch {
    return new Response("Couldn't read that file.", { status: 502 });
  }
  if (!res.ok && res.status !== 206) {
    // Google's own error text is never passed on.
    return new Response(null, { status: res.status === 404 || res.status === 403 || res.status === 401 ? 404 : res.status === 416 ? 416 : 502, headers: CORS });
  }
  const out = new Headers({ ...CORS, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Accept-Ranges": "bytes" });
  for (const name of PASS) {
    const v = res.headers.get(name);
    if (v) out.set(name, v);
  }
  const type = out.get("content-type");
  if (!type || type === "application/octet-stream") out.set("Content-Type", "video/mp4");
  return new Response(request.method === "HEAD" ? null : res.body, { status: res.status, headers: out });
}

const worker = {
  fetch: (request: Request, env: Env) => handle(request, env),
};
export default worker;
