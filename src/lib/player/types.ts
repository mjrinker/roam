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
