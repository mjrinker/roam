/** The shape of GET /api/download/.../options (shared by the server route and the browser). */
export interface DownloadOption {
  /** The version's key ("" for a file with no resolution label); what the play manifest's `version` takes. */
  label: string;
  /** "4K", "1080p", ... or "Audio". */
  name: string;
  height: number | null;
  /** Total size on disk, null when any file's size is unknown. */
  sizeBytes: number | null;
  parts: number;
}

export interface DownloadOptions {
  kind: "watch" | "listen";
  ownerKind: "title" | "episode";
  ownerId: string;
  title: string;
  subtitle: string | null;
  /** A picture to keep with the download so it can be shown offline (a TMDB or cover address). */
  posterUrl: string | null;
  options: DownloadOption[];
}
