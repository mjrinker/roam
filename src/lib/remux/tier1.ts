/**
 * Tier 1: remux a small file inline in this function invocation. Downloads
 * the whole input to /tmp first (fresh URL, so nothing depends on a presigned
 * URL still being valid minutes later), runs ffmpeg against the local file
 * (fully seekable, so a non-faststart MP4 is fine), then uploads from disk.
 */
import { chmod, copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFreshDownloadUrl, mintUploadToken } from "@/lib/storage/box";
import { completeRemuxJob, failRemuxJob, type RemuxJob } from "./remux-pass";
import { downloadToFile, preflightUpload, runFfmpeg, uploadFile, type TokenProvider } from "./remux-core.mjs";

const WORK_ROOT = join(tmpdir(), "roam-remux");
/** Longer than any job can legitimately run, so a sweep never deletes a live job's directory. */
const STALE_DIR_MS = 15 * 60_000;
/** Hard stop for ffmpeg, safely inside the route's 300s maxDuration. */
const FFMPEG_TIMEOUT_MS = 200_000;

let ffmpegPath: string | null = null;

/** The bundled static ffmpeg, copied somewhere executable (a traced file can lose its exec bit). */
export async function ensureFfmpeg(): Promise<string> {
  if (ffmpegPath) return ffmpegPath;
  const installer = (await import("@ffmpeg-installer/ffmpeg")).default;
  const dest = join(tmpdir(), "roam-ffmpeg");
  await copyFile(installer.path, dest);
  await chmod(dest, 0o755);
  ffmpegPath = dest;
  return dest;
}

/** Removes work dirs a hard-killed invocation's `finally` never got to. */
async function sweepStaleWorkDirs(): Promise<void> {
  try {
    for (const name of await readdir(WORK_ROOT)) {
      const dir = join(WORK_ROOT, name);
      const { mtimeMs } = await stat(dir);
      if (Date.now() - mtimeMs > STALE_DIR_MS) await rm(dir, { recursive: true, force: true });
    }
  } catch {
    // WORK_ROOT doesn't exist yet, or a dir vanished mid-sweep — nothing to do.
  }
}

/** Caches a folder-scoped upload token until shortly before it expires; `force` mints a new one (after a 401). */
export function uploadTokenProvider(serverId: string, folderId: string): TokenProvider {
  let cached: { accessToken: string; expiresAt: number } | null = null;
  return async (force) => {
    if (force || !cached || cached.expiresAt - Date.now() < 60_000) {
      const t = await mintUploadToken(serverId, folderId);
      cached = { accessToken: t.accessToken, expiresAt: t.expiresAt.getTime() };
    }
    return cached.accessToken;
  };
}

/** Runs one claimed job to completion (success or recorded failure). Never throws. */
export async function runTier1Job(job: RemuxJob): Promise<void> {
  await sweepStaleWorkDirs();
  const dir = join(WORK_ROOT, randomUUID());
  try {
    await mkdir(dir, { recursive: true });
    const getToken = uploadTokenProvider(job.serverId, job.folderId);

    // Ask Box first: a name already in use means an earlier attempt finished
    // uploading (link it instead of redoing the work), and a size cap fails
    // here rather than after minutes of ffmpeg. The input's size is an upper
    // bound for the output's.
    const pre = await preflightUpload({
      getToken,
      folderId: job.folderId,
      name: job.outputName,
      size: job.sizeBytes ?? 0,
    });
    if (pre.conflictId) {
      await completeRemuxJob(job.jobToken, { id: pre.conflictId });
      return;
    }

    const input = join(dir, "input.mp4");
    const output = join(dir, "output.mp4");
    const { url } = await getFreshDownloadUrl(job.serverId, job.boxFileId);
    await downloadToFile(url, input);
    await runFfmpeg(await ensureFfmpeg(), input, output, { timeoutMs: FFMPEG_TIMEOUT_MS });
    await rm(input, { force: true });

    const uploaded = await uploadFile({ getToken, folderId: job.folderId, name: job.outputName, filePath: output });
    await completeRemuxJob(
      job.jobToken,
      "conflictId" in uploaded ? { id: uploaded.conflictId } : { id: uploaded.id, name: uploaded.name, size: uploaded.size }
    );
  } catch (err) {
    await failRemuxJob(job.jobToken, (err as Error).message).catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
