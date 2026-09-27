import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mediaFiles, titles, watchState } from "@/lib/db/schema";
import { createBoxProviderForServer } from "@/lib/storage/box";
import { BoxReauthRequiredError } from "@/lib/storage/box-token-storage";
import { findSegmentAt } from "@/lib/player/timeline";
import type { AudiobookManifest, AudiobookSegment, AudiobookSegmentUrl } from "@/lib/player/types";

export type AudiobookResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 404 | 409 | 424; error: string };

const REAUTH_ERROR = "This server's Box connection needs to be reconnected by an admin.";

/**
 * Builds the timeline for an audiobook plus streaming URLs for the part to
 * resume in and the one after it. `serverId` must already be resolved and
 * authorized by the caller.
 */
export async function buildAudiobookManifest(
  titleId: string,
  profileId: string,
  serverId: string
): Promise<AudiobookResult<AudiobookManifest>> {
  const [title] = await db.select().from(titles).where(eq(titles.id, titleId)).limit(1);
  if (!title || title.kind !== "audiobook") return { ok: false, status: 404, error: "Not found" };

  const rows = await db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.ownerKind, "title"), eq(mediaFiles.ownerId, titleId)))
    .orderBy(asc(mediaFiles.partIndex));

  // duration_ms is authoritative; older rows only have whole seconds.
  const durations = rows.map((r) => (r.durationMs ?? (r.durationSeconds != null ? r.durationSeconds * 1000 : null)));
  if (rows.length === 0 || durations.some((d) => d === null)) {
    return { ok: false, status: 409, error: "Not ready to play yet (still scanning/probing)" };
  }

  let at = 0;
  const segments: AudiobookSegment[] = rows.map((_, index) => {
    const durationSeconds = (durations[index] as number) / 1000;
    const segment = { index, startSeconds: at, durationSeconds };
    at += durationSeconds;
    return segment;
  });
  const durationSeconds = at;

  const [state] = await db
    .select()
    .from(watchState)
    .where(
      and(
        eq(watchState.profileId, profileId),
        eq(watchState.ownerKind, "title"),
        eq(watchState.ownerId, titleId)
      )
    )
    .limit(1);
  const resumeSeconds = state && !state.finished ? Math.min(state.positionSeconds, durationSeconds) : 0;

  const { index: resumeIndex } = findSegmentAt(segments, durationSeconds, resumeSeconds);
  const provider = createBoxProviderForServer(serverId);
  const urls: AudiobookSegmentUrl[] = [];
  try {
    for (const index of [resumeIndex, resumeIndex + 1]) {
      if (index >= rows.length) break;
      const { url, expiresAt } = await provider.getStreamingUrl(rows[index].boxFileId);
      urls.push({ index, url, expiresAt: expiresAt.toISOString() });
    }
  } catch (err) {
    if (err instanceof BoxReauthRequiredError) return { ok: false, status: 424, error: REAUTH_ERROR };
    throw err;
  }

  return {
    ok: true,
    value: {
      titleId,
      name: title.name,
      authors: title.authors ?? (title.folderAuthor ? [title.folderAuthor] : []),
      narrators: title.narrators ?? [],
      seriesName: title.seriesName,
      seriesPosition: title.seriesPosition,
      coverUrl: title.posterUrl,
      durationSeconds,
      segments,
      chapters: title.chapters ?? [],
      resumeSeconds,
      urls,
    },
  };
}

/** A fresh streaming URL for one part of a book (the client calls this as it reaches each part). */
export async function mintAudiobookSegmentUrl(
  titleId: string,
  index: number,
  serverId: string
): Promise<AudiobookResult<AudiobookSegmentUrl>> {
  const [row] = await db
    .select({ boxFileId: mediaFiles.boxFileId })
    .from(mediaFiles)
    .where(
      and(
        eq(mediaFiles.ownerKind, "title"),
        eq(mediaFiles.ownerId, titleId),
        eq(mediaFiles.partIndex, index)
      )
    )
    .limit(1);
  if (!row) return { ok: false, status: 404, error: "Not found" };

  try {
    const { url, expiresAt } = await createBoxProviderForServer(serverId).getStreamingUrl(row.boxFileId);
    return { ok: true, value: { index, url, expiresAt: expiresAt.toISOString() } };
  } catch (err) {
    if (err instanceof BoxReauthRequiredError) return { ok: false, status: 424, error: REAUTH_ERROR };
    throw err;
  }
}
