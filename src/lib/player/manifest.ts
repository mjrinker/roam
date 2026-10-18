import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, viewers, watchState } from "@/lib/db/schema";
import { createStorageForServer } from "@/lib/storage/server-storage";
import { StorageReauthRequiredError } from "@/lib/storage/reauth";
import type { PlayManifest, PlayOwnerKind, PlaySegment } from "@/lib/player/types";
import { buildPlaySegment } from "@/lib/player/timeline";
import { playbackChapters } from "@/lib/chapters/chapters";
import { normalizePrefs, type ContentFilterPrefs } from "@/lib/content-filter/categories";
import { mergePrefs } from "@/lib/content-filter/timeline";
import { playbackCues, skipsFor } from "@/lib/content-filter/playback";
import { dddConfigured } from "@/lib/ddd/client";
import { dddTarget, serverDddAccess } from "@/lib/ddd/lookup";
import { dddFor } from "@/lib/ddd/service";
import { dddCues } from "@/lib/ddd/transform";
import { skipSegmentsFor } from "@/lib/skipdb/client";
import { SKIP_KINDS, detectedMarksFromRows, fillDetected, preferOwn, skipMarksFromRows } from "@/lib/skipdb/marks";
import { normalizeAutoSkip } from "@/lib/skipdb/active";
import { shouldUseVariant } from "@/lib/player/variant-selection";
import { describeVersions, offeredRows, pickVersion, withoutUndecodableVideo } from "@/lib/player/versions";
import { isVideoCodecToken } from "@/lib/scan/codec-support";

/** How long to wait for Box to make its browser-friendly version of a video the first time it is opened (it is quick afterwards). */
export const BROWSER_VERSION_WAIT_MS = 40_000;

export type BuildManifestResult =
  | { ok: true; manifest: PlayManifest }
  | { ok: false; status: 404 | 409 | 415 | 424; error: string };

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
  unsupportedCodecs: readonly string[] = [],
  /**
   * Play the storage service's own browser-friendly version of each file instead of the original (falling
   * back to the original when it isn't ready). For libraries of phone videos: HEVC with the index at the
   * end of the file, which iOS Safari won't start and Chrome shows as a black picture.
   */
  preferBrowserVersion = false,
  /**
   * Which resolution version to play when the owner has several ("Movie - 1080p.mp4", "Movie - 4K.mp4"): an exact label, else the one
   * closest in height to `preferredHeight`, else the highest. Only versions that are fully probed are offered.
   */
  choice: { version?: string | null; preferredHeight?: number | null; /** Scenes to skip for this play only, on top of what the profile skips. */ extraSkip?: ContentFilterPrefs } = {}
): Promise<BuildManifestResult> {
  const everyRow = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, ownerKind), eq(mediaFiles.ownerId, ownerId)))
    .orderBy(asc(mediaFiles.versionLabel), asc(mediaFiles.partIndex));

  // A version whose files are not all probed yet can't be played (it has no length), so it is not offered until it is.
  const playable = offeredRows(everyRow);
  // Versions in a video format this device can't decode (HEVC on iOS or most PCs) are left out, so it plays one it can; if none is
  // left it says so plainly rather than loading forever.
  const badVideo = unsupportedCodecs.filter(isVideoCodecToken);
  const offered = badVideo.length === 0 ? playable : withoutUndecodableVideo(playable, badVideo);
  if (playable.length > 0 && offered.length === 0) {
    return { ok: false, status: 415, error: "This device can't play this video: it is stored in a format (HEVC) that your browser doesn't support, and there is no other version of it yet." };
  }
  const versions = describeVersions(offered);
  const version = pickVersion(versions, choice.version ?? null, choice.preferredHeight ?? null);
  const allRows = offered.filter((r) => r.versionLabel === version);

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

  const provider = createStorageForServer(serverId);

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
      let usedVariant: typeof row | null = null;
      const variant = variantByPrimaryId.get(row.id);
      if (variant && shouldUseVariant(row, variant, unsupportedCodecs)) {
        // Any trouble minting the copy's URL just means playing the original.
        streaming = await provider.getStreamingUrl(variant.boxFileId).catch(() => null);
        if (streaming) usedVariant = variant;
      }
      if (!streaming && preferBrowserVersion && provider.getBrowserVideoUrl) {
        // Any trouble just means playing the original.
        streaming = await provider.getBrowserVideoUrl(row.boxFileId, { budgetMs: BROWSER_VERSION_WAIT_MS }).catch((err) => {
          if (err instanceof StorageReauthRequiredError) throw err;
          return null;
        });
      }
      const { url, expiresAt } = streaming ?? (await provider.getStreamingUrl(row.boxFileId));
      if (!earliestExpiry || expiresAt < earliestExpiry) earliestExpiry = expiresAt;
      const segment: PlaySegment = { ...buildPlaySegment(row, index, url, cursor), fileId: (usedVariant ?? row).id, sizeBytes: (usedVariant ?? row).sizeBytes ?? undefined, container: (usedVariant ?? row).container ?? undefined };
      segments.push(segment);
      // A trimmed segment's window duration, not the whole physical
      // file's — the next segment's startSeconds has to pick up right
      // where THIS episode's slice ends, not where the shared file ends.
      cursor += segment.durationSeconds;
    }
  } catch (err) {
    if (err instanceof StorageReauthRequiredError) {
      return {
        ok: false,
        status: 424,
        error: "This server's Box connection needs to be reconnected by an admin.",
      };
    }
    throw err;
  }

  // What this viewer has chosen to skip, applied to the scenes the video's filter file lists.
  const [viewerRow] = await db.select({ contentFilter: viewers.contentFilter, autoSkip: viewers.autoSkip }).from(viewers).where(eq(viewers.id, viewerId)).limit(1);
  const prefs = mergePrefs(normalizePrefs(viewerRow?.contentFilter), choice.extraSkip ?? {});
  let notice: string | undefined;
  let skips: PlayManifest["skips"] = [];
  if (Object.keys(prefs).length > 0) {
    const fileCues = playbackCues(
      segments.map((seg, i) => ({
        startSeconds: seg.startSeconds,
        durationSeconds: seg.durationSeconds,
        inFileOffsetSeconds: seg.inFileOffsetSeconds,
        inFileEndSeconds: seg.inFileEndSeconds,
        cues: [...(segmentRows[i].contentCues ?? []), ...(segmentRows[i].markedCues ?? []), ...(segmentRows[i].languageCues ?? [])],
      })),
      cursor
    );
    // Scenes the Does the Dog Die community reported, when this server uses it (see lib/ddd): from what is kept, or asked for once now.
    // Never worth holding playback up for: if it can't be had in a moment, the film plays without it and says so.
    let communityCues: typeof fileCues = [];
    const access = ownerKind === "extra" || !dddConfigured() ? "disabled" : await serverDddAccess(db, serverId);
    if (access !== "disabled") {
      const target = await dddTarget(db, ownerKind, ownerId);
      if (target) {
        const answer = await dddFor(target.lookup, access, "play", { timeoutMs: 2500 });
        if (answer.status === "ok") communityCues = dddCues(answer.data, target.owner).filter((c) => c.startSeconds < cursor).map((c) => ({ ...c, endSeconds: Math.min(c.endSeconds, cursor) }));
        else if (answer.status === "unavailable") notice = "Content filtering from the community isn't available for this title right now, so it is playing without it.";
      }
    }
    skips = skipsFor([...fileCues, ...communityCues], prefs);
  }

  // Intro, recap and credits times from SkipDB, for the skip buttons (see lib/skipdb): asked for live, never waited on for long, and a
  // film without any simply has no buttons. Not for trailers and extras, nor for phone videos in a photo library.
  // Times marked by hand here win, one kind at a time; SkipDB is not even asked once every kind has one.
  let skipSegments: PlayManifest["skipSegments"] = [];
  if (ownerKind !== "extra" && !preferBrowserVersion) {
    const own = skipMarksFromRows(segmentRows).map((m) => ({ ...m, source: "own" as const }));
    let remote: Awaited<ReturnType<typeof skipSegmentsFor>> = [];
    if (SKIP_KINDS.some((k) => !own.some((m) => m.kind === k))) {
      const target = await dddTarget(db, ownerKind, ownerId);
      if (target) remote = await skipSegmentsFor({ imdbId: target.lookup.imdbId, ...(target.owner.kind === "episode" ? { season: target.owner.season, episode: target.owner.episode } : {}) }, cursor);
    }
    skipSegments = fillDetected(preferOwn(own, remote), detectedMarksFromRows(segmentRows));
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
      // Phone videos in a photo library always start from the beginning, like opening a picture.
      resumeSeconds: preferBrowserVersion || ownerKind === "extra" || existingState?.finished ? 0 : (existingState?.positionSeconds ?? 0),
      version,
      versions,
      expiresAt: (earliestExpiry ?? new Date(Date.now() + 60_000)).toISOString(),
      skips,
      ...(skipSegments && skipSegments.length > 0 ? { skipSegments } : {}),
      ...(Object.keys(normalizeAutoSkip(viewerRow?.autoSkip)).length > 0 ? { autoSkip: normalizeAutoSkip(viewerRow?.autoSkip) } : {}),
      ...(notice ? { notice } : {}),
      // Part boundaries are not chapters: only what the files' own chapters say, moved onto this clock.
      chapters: playbackChapters(
        segments.map((seg, i) => ({
          startSeconds: seg.startSeconds,
          durationSeconds: seg.durationSeconds,
          inFileOffsetSeconds: seg.inFileOffsetSeconds,
          inFileEndSeconds: seg.inFileEndSeconds,
          chapters: segmentRows[i].chapters,
        })),
        cursor
      ),
    },
  };
}
