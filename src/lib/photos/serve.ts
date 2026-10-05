/**
 * The shared gate for the photo image routes (thumbnail, preview, original). Every outcome that isn't
 * "yes, you may have this" is the SAME not-found, so these routes never confirm that a photo exists:
 * a malformed id, a missing title, a library the account can't see, a title above the profile's age
 * limit, a title of the wrong kind, and a title outside a photo library all look alike.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { mediaFiles } from "@/lib/db/schema";
import type { TitleKind } from "@/lib/db/schema";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";
import { checkRateLimit } from "@/lib/rate-limit";
import { isBoxHost } from "@/lib/storage/box-representations";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import { createBoxProviderForServer } from "@/lib/storage/box";

export const PRIVATE_HEADERS = {
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

export const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

export interface PhotoFile {
  serverId: string;
  profileId: string;
  fileId: string;
  sizeBytes: number | null;
  container: string | null;
}

/** Items of a photo library that may be served: pictures, and (for thumbnails and originals) the videos beside them. */
export async function authorizePhotoFile(
  id: string,
  kinds: readonly TitleKind[],
  limit: { bucket: string; max: number }
): Promise<{ ok: true; file: PhotoFile } | { ok: false; response: Response }> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false, response: notFound() };
  const auth = await authorizeOwner("title", id, { titleKinds: kinds });
  if (!auth.ok || !isPhotoLibraryKind(auth.libraryKind)) return { ok: false, response: notFound() };

  // Only now that the caller is known to be allowed does a request spend rate-limit budget.
  if (!(await checkRateLimit(auth.member.profile.id, limit.bucket, limit.max, 60))) {
    return { ok: false, response: NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Cache-Control": "no-store" } }) };
  }

  const [media] = await db
    .select({ fileId: mediaFiles.boxFileId, sizeBytes: mediaFiles.sizeBytes, container: mediaFiles.container })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, id), eq(mediaFiles.partIndex, 0)))
    .limit(1);
  if (!media) return { ok: false, response: notFound() };

  return { ok: true, file: { serverId: auth.serverId, profileId: auth.member.profile.id, fileId: media.fileId, sizeBytes: media.sizeBytes, container: media.container } };
}

/** Box being unreachable or the connection needing re-authorisation is not "no such photo": say so, uncached. */
export function storageFailure(err: unknown): Response {
  const reauth = err instanceof BoxReauthRequiredError;
  return NextResponse.json({ error: reauth ? "Storage needs to be reconnected" : "Storage unavailable" }, { status: reauth ? 503 : 502, headers: { "Cache-Control": "no-store" } });
}

/** A redirect to a short-lived download URL for the original file, never stored by a cache. */
export async function redirectToOriginal(file: PhotoFile): Promise<Response> {
  const { url } = await createBoxProviderForServer(file.serverId).getStreamingUrl(file.fileId);
  // The URL came from Box's own API; still, a redirect is only ever made to a Box host over https.
  if (!isBoxHost(url)) return storageFailure(new Error("unexpected download host"));
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export function imageResponse(bytes: Uint8Array, cacheControl: string, extra: Record<string, string> = {}): Response {
  return new Response(bytes as unknown as BodyInit, { headers: { ...PRIVATE_HEADERS, "Content-Type": "image/jpeg", "Content-Length": String(bytes.length), "Cache-Control": cacheControl, ...extra } });
}
