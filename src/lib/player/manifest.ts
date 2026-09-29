import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, watchState } from "@/lib/db/schema";
import { createBoxProviderForServer } from "@/lib/storage/box";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import type { PlayManifest, PlayOwnerKind, PlaySegment } from "@/lib/player/types";
import { buildPlaySegment } from "@/lib/player/timeline";
import { shouldUseVariant } from "@/lib/player/variant-selection";

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
 *
 * `unsupportedCodecs` are the audio codecs this viewer's browser reported it
 * can't decode. A row whose audio is one of them plays its remuxed copy
 * instead, when one exists and checks out (see variant-selection.ts). Only
 * the copy's Box file is swapped in: trims and duration always come from the
 * primary row, since the episode-split pass only ever maintains those there.
 */
export async function buildPlayManifest(
  ownerKind: PlayOwnerKind,
  ownerId: string,
  viewerId: string,
  serverId: string,
  unsupportedCodecs: readonly string[] = []
): Promise<BuildManifestResult> {
  const allRows = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, ownerKind), eq(mediaFiles.ownerId, ownerId)))
    .orderBy(asc(mediaFiles.partIndex));

  // A row can be a physical part this owner's Box folder contains but that
  // its OWN estimated window doesn't touch at all — e.g. one part of a
  // combined multi-episode file that's ALSO split across multiple
  // physical files, where this episode's slice falls entirely in the
  // OTHER part (see episode-split-pass.ts). trimDurationSeconds === 0 is
  // that "deliberately excluded" marker, distinct from null (not
  // computed/not applicable) — drop it before it ever becomes a segment.
  const segmentRows = allRows.filter((r) => r.trimDurationSeconds !== 0);

  const incompleteSegment = segmentRows.find((s) => s.durationSeconds == null);
  if (segmentRows.length === 0 || incompleteSegment) {
    return {
      ok: false,
      status: 409,
      error: "Not ready to play yet (still scanning/probing)",
    };
  }

  const provider = createBoxProviderForServer(serverId);

  const variantByPrimaryId = new Map<string, typeof allRows[number]>();
  if (unsupportedCodecs.length > 0 && segmentRows.some((r) => r.audioCodec && unsupportedCodecs.includes(r.audioCodec.toLowerCase()))) {
    const variants = await db
      .select()
      .from(mediaFiles)
      .where(inArray(mediaFiles.variantOfMediaFileId, segmentRows.map((r) => r.id)));
    for (const v of variants) {
      if (v.variantOfMediaFileId) variantByPrimaryId.set(v.variantOfMediaFileId, v);
    }
  }

  let cursor = 0;
  let earliestExpiry: Date | null = null;
  const segments: PlaySegment[] = [];
  try {
    for (const [index, row] of segmentRows.entries()) {
      let streaming: { url: string; expiresAt: Date } | null = null;
      const variant = variantByPrimaryId.get(row.id);
      if (variant && shouldUseVariant(row, variant, unsupportedCodecs)) {
        // Any trouble minting the copy's URL just means playing the original.
        streaming = await provider.getStreamingUrl(variant.boxFileId).catch(() => null);
      }
      const { url, expiresAt } = streaming ?? (await provider.getStreamingUrl(row.boxFileId));
      if (!earliestExpiry || expiresAt < earliestExpiry) earliestExpiry = expiresAt;
      const segment = buildPlaySegment(row, index, url, cursor);
      segments.push(segment);
      // A trimmed segment's window duration, not the whole physical
      // file's — the next segment's startSeconds has to pick up right
      // where THIS episode's slice ends, not where the shared file ends.
      cursor += segment.durationSeconds;
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
        eq(watchState.viewerId, viewerId),
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
