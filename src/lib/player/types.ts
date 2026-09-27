/** Shared between the /api/play route and the client-side player. */

export type PlayOwnerKind = "title" | "episode";

export interface PlaySegment {
  index: number;
  url: string;
  durationSeconds: number;
  startSeconds: number;
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
  durationSeconds: number;
  segments: AudiobookSegment[];
  chapters: { title: string; startSeconds: number }[];
  resumeSeconds: number;
  urls: AudiobookSegmentUrl[];
}
