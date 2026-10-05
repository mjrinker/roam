import { authorizePhotoFile, imageResponse, notFound, PRIVATE_HEADERS, storageFailure } from "@/lib/photos/serve";
import { createBoxProviderForServer } from "@/lib/storage/box";

export const maxDuration = 30;

/** The version a thumbnail URL carries (see lib/photos/urls): a short run of [0-9a-z-], or none. */
const VERSION = /^[0-9a-z-]{1,40}$/;

/**
 * A photo's (or a video's) 320px thumbnail, fetched live from Box and passed through, never stored.
 * The URL's `v` changes only when the file's content does, so a browser may keep the answer for a
 * year; access is checked BEFORE anything is answered, including a 304, so a cached copy is never a
 * way around losing access to the library.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/photos/[id]/thumb">) {
  const { id } = await ctx.params;
  const auth = await authorizePhotoFile(id, ["photo", "movie"], { bucket: "photo_thumb", max: 3000 });
  if (!auth.ok) return auth.response;

  const raw = new URL(request.url).searchParams.get("v");
  const version = raw && VERSION.test(raw) ? raw : null;
  const etag = version ? `"t-${version}"` : null;
  const cache = version ? "private, max-age=86400, immutable" : "private, max-age=300";
  if (etag && request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ...PRIVATE_HEADERS, "Cache-Control": cache, ETag: etag } });
  }

  try {
    const thumb = await createBoxProviderForServer(auth.file.serverId).fetchThumbnail!(auth.file.fileId);
    // Box hasn't made one yet (or can't): not an error to remember, so it is never cached.
    if (!thumb) return notFound();
    return imageResponse(thumb.bytes, cache, etag ? { ETag: etag } : {});
  } catch (err) {
    return storageFailure(err);
  }
}

