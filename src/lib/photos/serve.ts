/**
 * The shared gate for the photo image routes (thumbnail, preview, original). Every outcome that isn't
 * "yes, you may have this" is the SAME not-found, so these routes never confirm that a photo exists:
 * a malformed id, a missing title, a library the account can't see, a title above the profile's age
 * limit, a title of the wrong kind, and a title outside a photo library all look alike.
 */
import { NextResponse } from "next/server";
import { BoxApiError } from "box-node-sdk";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { authorizeOwner } from "@/lib/auth/resolve-server";
import { db } from "@/lib/db/client";
import { mediaFiles, servers } from "@/lib/db/schema";
import type { TitleKind } from "@/lib/db/schema";
import { isPhotoLibraryKind } from "@/lib/libraries/profile";
import { checkRateLimit } from "@/lib/rate-limit";
import { isBoxHost } from "@/lib/storage/box-representations";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import { createBoxProviderForServer } from "@/lib/storage/box";

// No `Vary: Cookie`: the auth cookie is rewritten about hourly, which would make a browser throw away
// every cached thumbnail and refetch it through a Box-proxying function. `private` keeps shared caches
// out; access is still checked on every request that reaches the server; the URL's version token
// handles replaced files. The one trade-off: a copy already in THIS browser's cache survives a loss of access.
export const PRIVATE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

/** All photo requests of one server together: well under what Box allows a connected user, leaving room for playback. */
export const SERVER_BOX_CALLS_PER_MINUTE = 1500;

/**
 * One server's shared budget for photo requests. The limiter's table is keyed by an ACCOUNT, so the budget
 * is recorded against the server's owner under a bucket named for the server (any other id would be
 * refused by the table's foreign key, failing every request).
 */
export async function spendServerBudget(serverId: string): Promise<boolean> {
  const [server] = await db.select({ ownerId: servers.ownerId }).from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) return false;
  return checkRateLimit(server.ownerId, `photo_box:${serverId}`, SERVER_BOX_CALLS_PER_MINUTE, 60);
}

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

  // Only now that the caller is known to be allowed does a request spend rate-limit budget: the account's
  // own, and the whole server's. Every photo request is a live call to the one Box account that also serves
  // playback, scans and remuxing, so no one viewer (or a fast scroll) may use up its quota.
  const tooMany = () => ({ ok: false as const, response: NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "10" } }) });
  if (!(await checkRateLimit(auth.member.profile.id, limit.bucket, limit.max, 60))) return tooMany();
  if (!(await spendServerBudget(auth.serverId))) return tooMany();

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
  // Box asking us to slow down is passed on as such, so the browser backs off instead of treating it as broken.
  const limited = err instanceof BoxApiError && err.responseInfo?.statusCode === 429;
  return NextResponse.json(
    { error: reauth ? "Storage needs to be reconnected" : limited ? "Too many requests" : "Storage unavailable" },
    { status: reauth ? 503 : limited ? 429 : 502, headers: { "Cache-Control": "no-store", ...(limited ? { "Retry-After": "10" } : {}) } }
  );
}

/** A redirect to a short-lived download URL for the original file, never stored by a cache. */
export async function redirectToOriginal(file: PhotoFile): Promise<Response> {
  // A freshly minted URL, never one from the playback cache whose lifetime is the token's, not the URL's.
  const provider = createBoxProviderForServer(file.serverId);
  const { url } = await (provider.getFreshDownloadUrl ?? provider.getStreamingUrl)(file.fileId);
  // The URL came from Box's own API; still, a redirect is only ever made to a Box host over https.
  if (!isBoxHost(url)) return storageFailure(new Error("unexpected download host"));
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export function imageResponse(bytes: Uint8Array, cacheControl: string, extra: Record<string, string> = {}): Response {
  return new Response(bytes as unknown as BodyInit, { headers: { ...PRIVATE_HEADERS, "Content-Type": "image/jpeg", "Content-Length": String(bytes.length), "Cache-Control": cacheControl, ...extra } });
}
