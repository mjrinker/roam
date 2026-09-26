import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, watchState } from "@/lib/db/schema";
import { createBoxProviderForServer } from "@/lib/storage/box";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { PlayManifest, PlayOwnerKind, PlaySegment } from "@/lib/player/types";

export type BuildManifestResult =
  | { ok: true; manifest: PlayManifest }
  | { ok: false; status: 404 | 409 | 424; error: string };

/**
 * Builds a play manifest for a movie (ownerKind="title") or an episode
 * (ownerKind="episode") — same logic either way, since both are just an
 * ordered list of media_files. Mints a fresh, short-lived Box streaming URL
 * per segment; never caches URLs across requests. `serverId` must already
 * be resolved+authorized by the caller (see resolveServerIdForOwner +
 * requireServerMember in the route) — this function trusts it.
 */
export async function buildPlayManifest(
  ownerKind: PlayOwnerKind,
  ownerId: string,
  profileId: string,
  serverId: string
): Promise<BuildManifestResult> {
  const segmentRows = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, ownerKind), eq(mediaFiles.ownerId, ownerId)))
    .orderBy(asc(mediaFiles.partIndex));

  const incompleteSegment = segmentRows.find((s) => s.durationSeconds == null);
  if (segmentRows.length === 0 || incompleteSegment) {
    return {
      ok: false,
      status: 409,
      error: "Not ready to play yet (still scanning/probing)",
    };
  }

  const provider = createBoxProviderForServer(serverId);

  let cursor = 0;
  let earliestExpiry: Date | null = null;
  const segments: PlaySegment[] = [];
  try {
    for (const [index, row] of segmentRows.entries()) {
      const { url, expiresAt } = await provider.getStreamingUrl(row.boxFileId);
      if (!earliestExpiry || expiresAt < earliestExpiry) earliestExpiry = expiresAt;
      segments.push({
        index,
        url,
        durationSeconds: row.durationSeconds!,
        startSeconds: cursor,
      });
      cursor += row.durationSeconds!;
    }
  } catch (err) {
    if (err instanceof BoxReauthRequiredError) {
      return {
        ok: false,
        status: 424,
        error: "This server's Box connection needs to be reconnected by an admin.",
      };
    }
    throw err;
  }

  const [existingState] = await db
    .select()
    .from(watchState)
    .where(
      and(
        eq(watchState.profileId, profileId),
        eq(watchState.ownerKind, ownerKind),
        eq(watchState.ownerId, ownerId)
      )
    )
    .limit(1);

  return {
    ok: true,
    manifest: {
      ownerKind,
      ownerId,
      durationSeconds: cursor,
      segments,
      resumeSeconds: existingState?.finished ? 0 : (existingState?.positionSeconds ?? 0),
      expiresAt: (earliestExpiry ?? new Date(Date.now() + 60_000)).toISOString(),
    },
  };
}
