/** Shared between the /api/play route and the client-side player. */

export type PlayOwnerKind = "title" | "episode" | "extra";

export interface PlaySegment {
  index: number;
  url: string;
  durationSeconds: number;
  startSeconds: number;
  /** The physical file's size in bytes when known (a download shows progress against it). */
  sizeBytes?: number;
  /** The file's container ("mp4", "mkv"...) when known; the address has no file extension, so a native player needs this to know how to open it. */
  container?: string;
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
  /** The server limits playing at once, so this player holds a place and must send a heartbeat (see lib/ownership/client). */
  heartbeat?: boolean;
  ownerKind: PlayOwnerKind;
  ownerId: string;
  durationSeconds: number;
  segments: PlaySegment[];
  resumeSeconds: number;
  expiresAt: string;
  /** Chapters (movies and episodes), timed on the playback clock; missing or empty when there are fewer than two. */
  chapters?: { title: string; startSeconds: number }[];
  /** Scenes this viewer has chosen not to see or hear (see lib/content-filter), on the playback clock: skipped over, or played with the sound off. */
  skips?: { startSeconds: number; endSeconds: number; action: "skip" | "mute"; categories: string[] }[];
  /** Intro, recap, credits and preview times from SkipDB, on the playback clock, for the "Skip intro" style buttons. Absent when none are known. */
  skipSegments?: { kind: "intro" | "recap" | "outro" | "preview"; startSeconds: number; endSeconds: number; source?: "own" }[];
  /** Which parts this profile skips without being asked (the skip button pressed for it). */
  autoSkip?: Partial<Record<"intro" | "recap" | "outro" | "preview", boolean>>;
  /** Whether this viewer may mark scenes while watching (a server's admin), so the player offers the marking panel. */
  canMark?: boolean;
  /** A short message to show once when playback starts: filtering this viewer asked for could not be applied. */
  notice?: string;
  /** The resolution version this plays (its label; "" for a file with none) and every version on offer, best first. */
  version?: string;
  versions?: { label: string; name: string; height: number | null }[];
  /** The library this plays from, and the speed this profile starts it at (null or missing = normal speed). */
  libraryId?: string;
  defaultRate?: number | null;
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
  /** The server limits playing at once, so this player holds a place and must send a heartbeat. */
  heartbeat?: boolean;
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
  /** The library this plays from, and the speed this profile starts it at (null or missing = normal speed). */
  libraryId?: string;
  defaultRate?: number | null;
}
