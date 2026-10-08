/** Shared between the /api/play route and the client-side player. */

export type PlayOwnerKind = "title" | "episode";

export interface PlaySegment {
  index: number;
  url: string;
  durationSeconds: number;
  startSeconds: number;
  // Both PRESENT together only for a trimmed segment — an episode's
  // estimated slice of a multi-episode file (see lib/scan/episode-split.ts)
  // — and OMITTED entirely (not even `undefined`) for an ordinary segment,
  // since their presence is itself the signal the player checks
  // (see hasVirtualEnd in lib/player/timeline.ts).
  /** Where this segment's window starts in the underlying physical file. */
  inFileOffsetSeconds?: number;
  /** The physical-file time at which this segment virtually ends. */
  inFileEndSeconds?: number;
}

export interface PlayManifest {
  ownerKind: PlayOwnerKind;
  ownerId: string;
  durationSeconds: number;
  segments: PlaySegment[];
  resumeSeconds: number;
  expiresAt: string;
}

// ── Audiobooks ───────────────────────────────────────────────────────────
// Unlike a video manifest, segment URLs are NOT all minted up front: a book
// can have dozens of parts and each URL costs Box calls. The manifest carries
// the timeline plus URLs for the parts needed right away; the client asks
// /api/audiobooks/[id]/segments/[index] for the rest as it reaches them.

export interface AudiobookSegment {
  index: number;
  startSeconds: number;
  durationSeconds: number;
}

export interface AudiobookSegmentUrl {
  index: number;
  url: string;
  expiresAt: string;
}

export interface AudiobookManifest {
  titleId: string;
  name: string;
  authors: string[];
  narrators: string[];
  seriesName: string | null;
  seriesPosition: string | null;
  coverUrl: string | null;
  /** The album a song belongs to (music libraries); null for everything else. */
  albumId: string | null;
  durationSeconds: number;
  segments: AudiobookSegment[];
  chapters: { title: string; startSeconds: number }[];
  resumeSeconds: number;
  urls: AudiobookSegmentUrl[];
}
