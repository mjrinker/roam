import { loadConnection } from "@/lib/storage/registry";
import { googleDownload } from "@/lib/storage/google-drive";
import { verifyStreamToken } from "@/lib/storage/stream-token";
import { StorageReauthRequiredError } from "@/lib/storage/reauth";

// A film is read in long stretches; give a request the longest a function may run (the player simply asks again for the next stretch).
export const maxDuration = 300;

const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];

/**
 * Plays one Google Drive file. The address carries a signed token naming the file and connection (stream-token.ts), so no login is
 * needed to follow it and nothing else can be read with it. Range requests pass straight through, which is how a player seeks.
 */
async function serve(request: Request, token: string, head: boolean): Promise<Response> {
  const named = verifyStreamToken(token);
  if (!named) return new Response("Not found", { status: 404 });
  const conn = await loadConnection(named.connectionId);
  if (!conn || conn.provider !== "gdrive") return new Response("Not found", { status: 404 });

  try {
    const upstream = await googleDownload(conn.id, named.fileId, request.headers.get("range"));
    if (!upstream.ok && upstream.status !== 206) {
      // Google's own error text is never passed on; a missing file or a refused range is all the player needs to know.
      return new Response(null, { status: upstream.status === 404 || upstream.status === 403 ? 404 : upstream.status === 416 ? 416 : 502 });
    }
    // The address is the credential (a signed link, like the other providers' download links), so any page may use it, which is what
    // lets a download-for-offline request from another of the site's addresses read it.
    const headers = new Headers({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges" });
    for (const name of PASS) {
      const v = upstream.headers.get(name);
      if (v) headers.set(name, v);
    }
    if (!headers.get("content-type") || headers.get("content-type") === "application/octet-stream") headers.set("Content-Type", "video/mp4");
    return new Response(head ? null : upstream.body, { status: upstream.status, headers });
  } catch (err) {
    if (err instanceof StorageReauthRequiredError) return new Response("This storage needs to be signed in again by an admin.", { status: 424 });
    return new Response("Couldn't read that file.", { status: 502 });
  }
}

export async function GET(request: Request, ctx: RouteContext<"/api/storage/stream/[token]">) {
  return serve(request, (await ctx.params).token, false);
}
export async function HEAD(request: Request, ctx: RouteContext<"/api/storage/stream/[token]">) {
  return serve(request, (await ctx.params).token, true);
}
