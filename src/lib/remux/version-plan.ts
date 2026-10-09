/**
 * Planning resolution versions of a video (scripts/make-versions-box.ts): which smaller resolutions to make, what to call each file, and
 * how to encode it. Pure, so it can be tested without ffmpeg or Box.
 */
import { resolutionName } from "@/lib/scan/conventions";

/** The picture heights versions are made at, largest first. */
export const RUNGS = [2160, 1440, 1080, 720, 480, 360, 240, 144] as const;

/** Box's largest file on the plan in use; an encode that would pass it is squeezed until it fits. */
export const MAX_OUTPUT_BYTES = Math.floor(1.9 * 1024 ** 3);

/** The height a picture counts as: the larger of its height and what its width implies at 16:9 (a cropped 1920x800 film is 1080p). */
export function effectiveHeight(width: number, height: number): number {
  return Math.max(height, Math.round((width * 9) / 16));
}

/** The label to put in the original's file name: "1080p", "720p", "2160p" (4K) - what resolution it is. */
export function originalLabel(width: number, height: number): string {
  const name = resolutionName(width, height) ?? "";
  return name === "4K" ? "2160p" : name === "8K" ? "4320p" : name;
}

export function rungLabel(rung: number): string {
  return `${rung}p`;
}

/** The rungs to make from a source: every one below the source's own resolution (never the same label, never an upscale), limited to `wanted` if given. */
export function rungsBelow(width: number, height: number, wanted?: readonly number[]): number[] {
  const own = effectiveHeight(width, height);
  const ownLabel = originalLabel(width, height);
  return RUNGS.filter((r) => r < own && rungLabel(r) !== ownLabel && (!wanted || wanted.includes(r)));
}

/** The picture size for a rung: scaled to the same shape as the source (even numbers, which H.264 needs). */
export function rungSize(width: number, height: number, rung: number): { width: number; height: number } {
  const factor = rung / effectiveHeight(width, height);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(width * factor), height: even(height * factor) };
}

/** Video bitrate ceilings (kbit/s) and audio bitrates (kbit/s) per rung. */
const VIDEO_KBPS: Record<number, number> = { 2160: 16000, 1440: 6000, 1080: 4000, 720: 2500, 480: 1200, 360: 700, 240: 400, 144: 200 };
const AUDIO_KBPS: Record<number, number> = { 2160: 128, 1440: 128, 1080: 128, 720: 128, 480: 128, 360: 96, 240: 64, 144: 48 };

export function audioKbps(rung: number): number {
  return AUDIO_KBPS[rung] ?? 96;
}

/**
 * The most video bitrate (kbit/s) to allow: the rung's ceiling, lowered so a long film still fits in `maxBytes`
 * (a 3-hour 1440p at 6000 kbit/s would not).
 */
export function videoKbps(rung: number, durationSeconds: number | null, maxBytes = MAX_OUTPUT_BYTES, audioKbpsUsed = audioKbps(rung)): number {
  const ceiling = VIDEO_KBPS[rung] ?? 1000;
  if (!durationSeconds || durationSeconds <= 0) return ceiling;
  const fits = Math.floor((maxBytes * 8) / durationSeconds / 1000) - audioKbpsUsed - 32; // 32: container overhead
  return Math.max(100, Math.min(ceiling, fits));
}

/** ffmpeg codec names a browser plays inside an MP4 as they are; anything else (AC-3, E-AC-3, DTS, TrueHD, PCM ...) also gets an AAC copy. */
const BROWSER_SAFE_FFMPEG_AUDIO = new Set(["aac", "mp3", "opus", "flac", "vorbis"]);

export function audioNeedsAacCopy(ffmpegCodec: string | null): boolean {
  return ffmpegCodec !== null && !BROWSER_SAFE_FFMPEG_AUDIO.has(ffmpegCodec.toLowerCase());
}

/**
 * The ffmpeg arguments for one rung: H.264 at the rung's size and bitrate ceiling, faststart (our duration reader needs a plain,
 * non-fragmented file). `audioMode: "copy"` keeps the original's audio untouched; "aac" re-encodes it to stereo AAC at the rung's bitrate.
 * `inputArgs` is everything that names the input, e.g. ["-i", file] or, for a film in several parts, ["-f", "concat", "-safe", "0", "-i", list].
 */
export function buildVersionArgs(inputArgs: string[], output: string, opts: { width: number; height: number; rung: number; kbps: number; preset: string; crf: number; audioMode: "copy" | "aac" }): string[] {
  const size = rungSize(opts.width, opts.height, opts.rung);
  return [
    "-y", "-hide_banner", "-loglevel", "error", "-stats",
    ...inputArgs,
    "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
    "-vf", `scale=${size.width}:${size.height}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", opts.preset, "-profile:v", "high", "-crf", String(opts.crf),
    "-maxrate", `${opts.kbps}k`, "-bufsize", `${opts.kbps * 2}k`,
    ...(opts.audioMode === "copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-ac", "2", "-b:a", `${audioKbps(opts.rung)}k`]),
    "-movflags", "+faststart",
    output,
  ];
}
