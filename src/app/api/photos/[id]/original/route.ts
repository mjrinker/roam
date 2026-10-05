import { authorizePhotoFile, redirectToOriginal, storageFailure } from "@/lib/photos/serve";

export const maxDuration = 30;

/**
 * "Download original": a redirect to a short-lived Box download URL for this one file. Never cached
 * (the URL is a credential for about as long as it lives), and limited more tightly than thumbnails
 * because it is the route that moves real bandwidth. Same gate as every photo route; a video in a
 * photo library can be downloaded the same way.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/photos/[id]/original">) {
  const { id } = await ctx.params;
  const auth = await authorizePhotoFile(id, ["photo", "movie"], { bucket: "photo_original", max: 120 });
  if (!auth.ok) return auth.response;
  try {
    return await redirectToOriginal(auth.file);
  } catch (err) {
    return storageFailure(err);
  }
}
