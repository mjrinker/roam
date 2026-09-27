import type { AudnexusChapters } from "@/lib/audible/parse";

export interface BookChapter {
  title: string;
  startSeconds: number;
}

export interface BookPart {
  filename: string;
  durationMs: number;
  /** Chapters embedded in this file, times relative to the file. */
  chapters: BookChapter[] | null;
}

/** "03 - The Storm.mp3" -> "The Storm"; bare split markers ("Book - pt2.mp3") -> "Part 2". */
export function partTitle(filename: string, index: number): string {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  const withoutTrackNumber = base.replace(/^\d+\s*[-._)]\s*/, "").trim();
  const isSplitMarker = /(?:^|[-_\s])(?:cd|disc|disk|dvd|part|pt)\s*0*\d+$/i.test(withoutTrackNumber);
  return !withoutTrackNumber || isSplitMarker || /^\d+$/.test(withoutTrackNumber)
    ? `Part ${index + 1}`
    : withoutTrackNumber;
}

function offsetsSeconds(parts: BookPart[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const p of parts) {
    offsets.push(at);
    at += p.durationMs / 1000;
  }
  return offsets;
}

/**
 * Chapters read from the files themselves, joined across parts with each
 * part's start offset. A part with no embedded chapters becomes a single
 * chapter named after its file, so mixed books still cover the whole
 * timeline. Null when no part has any.
 */
export function embeddedChapters(parts: BookPart[]): BookChapter[] | null {
  if (!parts.some((p) => p.chapters && p.chapters.length > 0)) return null;
  const offsets = offsetsSeconds(parts);
  return parts.flatMap((p, i) =>
    p.chapters && p.chapters.length > 0
      ? p.chapters.map((c) => ({ title: c.title, startSeconds: offsets[i] + c.startSeconds }))
      : [{ title: partTitle(p.filename, i), startSeconds: offsets[i] }]
  );
}

/** One chapter per file, for multi-file books with nothing better. Null for a single file. */
export function perFileChapters(parts: BookPart[]): BookChapter[] | null {
  if (parts.length < 2) return null;
  const offsets = offsetsSeconds(parts);
  return parts.map((p, i) => ({ title: partTitle(p.filename, i), startSeconds: offsets[i] }));
}

/**
 * Fits Audnexus's chapter list onto our files. Its timeline includes
 * Audible's brand intro/outro, which a ripped file may or may not contain, so
 * try each plausible alignment and take the one whose total runtime is
 * closest to ours, provided it's within max(2%, 30s). Null if none fit (better no chapters than
 * chapters at the wrong times).
 */
export function alignAudnexusChapters(aud: AudnexusChapters, totalMs: number): BookChapter[] | null {
  if (aud.chapters.length === 0 || totalMs <= 0) return null;
  const last = aud.chapters[aud.chapters.length - 1];
  const runtimeMs = aud.runtimeMs ?? (last.startSeconds + last.lengthSeconds) * 1000;
  const tolerance = Math.max(0.02 * totalMs, 30_000);

  const candidates = [
    { shiftMs: 0, runtimeMs },
    { shiftMs: -aud.introMs, runtimeMs: runtimeMs - aud.introMs - aud.outroMs },
    { shiftMs: -aud.introMs, runtimeMs: runtimeMs - aud.introMs },
    { shiftMs: 0, runtimeMs: runtimeMs - aud.outroMs },
  ];
  // Closest runtime wins (earlier candidate on ties): within a loose
  // tolerance several alignments can qualify, but only one is exact.
  let fit: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    const diff = Math.abs(c.runtimeMs - totalMs);
    if (diff <= tolerance && (!fit || diff < Math.abs(fit.runtimeMs - totalMs))) fit = c;
  }
  if (!fit) return null;

  const totalSeconds = totalMs / 1000;
  const chapters: BookChapter[] = [];
  for (const c of aud.chapters) {
    const start = c.startSeconds + fit.shiftMs / 1000;
    const end = start + c.lengthSeconds;
    if (c.lengthSeconds > 0 && end <= 0) continue; // entirely inside the trimmed intro
    if (start >= totalSeconds) continue; // entirely inside the trimmed outro
    chapters.push({ title: c.title, startSeconds: Math.max(0, start) });
  }
  return chapters.length > 0 ? chapters : null;
}
