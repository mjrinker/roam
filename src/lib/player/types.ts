/** Shared between the /api/play route and the client-side player. */

export interface PlaySegment {
  index: number;
  url: string;
  durationSeconds: number;
  startSeconds: number;
}

export interface PlayManifest {
  titleId: string;
  durationSeconds: number;
  segments: PlaySegment[];
  resumeSeconds: number;
  expiresAt: string;
}
