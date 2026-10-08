export const CHUNKED_UPLOAD_MIN_BYTES: number;
export function buildFfmpegArgs(input: string, output: string, opts?: { channels?: number }): string[];
export function runFfmpeg(
  ffmpegPath: string,
  input: string,
  output: string,
  opts?: { timeoutMs?: number; channels?: number }
): Promise<void>;
export function downloadToFile(url: string, dest: string): Promise<void>;
export function conflictIdFrom(body: unknown): string | null;
export type TokenProvider = (forceRefresh: boolean) => Promise<string>;
export function preflightUpload(args: {
  getToken: TokenProvider;
  folderId: string;
  name: string;
  size: number;
}): Promise<{ conflictId: string | null }>;
export type UploadResult = { id: string; name: string; size: number } | { conflictId: string };
export function uploadFile(args: {
  getToken: TokenProvider;
  folderId: string;
  name: string;
  filePath: string;
  replaceFileId?: string;
  /** Stamps a new small file with this creation date (ISO time). */
  contentCreatedAt?: string;
  onProgress?: (p: { part: number; parts: number; uploadedBytes: number; size: number }) => void;
}): Promise<UploadResult>;
